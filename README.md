# blu3-server

Real-time collaborative music room backend for [Blu3](https://blu3.in). Powers room state, synchronized playback, the collaborative queue, chat, playlists, and audio resolution across YouTube + JioSaavn. Built with [Hono](https://hono.dev/), [Drizzle ORM](https://orm.drizzle.team/), [better-auth](https://www.better-auth.com/), and [Upstash Redis](https://upstash.com/).

> The frontend lives in [`blu3-client`](../blu3-client) — this repo is the API + WebSocket server it talks to. If you're contributing to the client, you only need a running `blu3-server` instance and the three `NEXT_PUBLIC_*` env vars described in [Connecting the frontend](#connecting-the-frontend).

## Quick Start

> **Prerequisites:** Node.js >= 20 (or [Bun](https://bun.sh)), a PostgreSQL database (Neon works), and optionally an Upstash Redis instance for rate limiting.

```bash
# install
bun install

# configure (see Environment Variables — fill in your own secrets)
cp .env.example .env

# run pending migrations
bun run db:migrate

# start dev (tsx watch, hot reload)
bun run dev
```

Server boots on `http://localhost:8000`. Health: `/healthz`. Readiness (DB + Redis): `/readyz`.

## Connecting the frontend

`blu3-client` is configured entirely via three env vars. Point them at your running `blu3-server`:

```
NEXT_PUBLIC_API_URL=http://localhost:8000   # REST base
NEXT_PUBLIC_WS_URL=ws://localhost:8000      # WebSocket base (the /ws path is appended)
NEXT_PUBLIC_APP_URL=http://localhost:3000   # public-facing client URL (CORS / OAuth redirect)
```

The server's `FRONTEND_URL` / `CORS_ORIGINS` must include the client origin you're running, otherwise cookies and CORS will silently fail. Defaults already include `http://localhost:3000` and `https://blu3.in`.

## How auth works (read this first)

Auth is handled by `better-auth` mounted at `GET|POST /api/auth/*` (Google + Discord OAuth, plus session cookies). Two token shapes are accepted by protected endpoints:

1. **Cookie** — `better-auth.session_token` (set automatically by the OAuth flow). Used by browser requests with `credentials: "include"`.
2. **Bearer** — `Authorization: Bearer <token>` where `<token>` is the `session.token` value. Used by non-browser clients (Electron, the audio proxy `<audio>` tag, WebSocket).

`getSessionFromRequest` (`src/lib/auth.ts`) tries the cookie first, then falls back to a DB lookup on the Bearer token. The Electron desktop flow uses `GET /api/auth/desktop-redirect` — after OAuth completes it reads the session cookie and redirects to `blu3://auth-callback?token=...` so the desktop app can capture the token.

**WebSocket auth** — the `/ws` upgrade reads `?token=` from the query string. The token is the same session token (Bearer shape). The WS handler caches the resolved user for 5 minutes per token.

## Architecture

```
src/
  index.ts              ← Server entry: CORS, request logging, better-auth mount,
                          WS upgrade, inline routes (search, resolve, resolve-link,
                          audio proxy, desktop-redirect, health, readyz)
  lib/
    env.ts              ← dotenv loader (import first in any entry point)
    auth.ts             ← better-auth setup + getSessionFromRequest (cookie + Bearer)
    broadcaster.ts      ← Broadcaster interface + LocalBroadcaster (in-process WS fanout)
    jiosaavnAudio.ts    ← JioSaavn search + DES-encrypted CDN URL resolution
    matching.ts         ← shared helpers: normalizeStr, isDurationMatchMs, upscaleJioImage
    ratelimit.ts        ← Redis-backed sliding-window rate limiter (fails open)
    redis.ts            ← Upstash Redis client (used by ratelimit only)
    requireAuth.ts      ← shared requireAuth middleware + AuthEnv type
    responseCache.ts    ← simple TTL in-memory response cache
    roomStore.ts        ← RoomStore interface + MemoryRoomStore (in-process room state)
    timeline.ts         ← timeline snapshot math (currentPosition, play/pause/resume/seek/elapsed)
    ytAudio.ts          ← ytmusic-api wrapper: search, audio URL, metadata, album art
  db/
    index.ts            ← Drizzle db instance (postgres-js driver)
    schema.ts           ← all pgTable definitions (users, sessions, accounts, verifications,
                          rooms, roomMembers, roomTrackHistory, roomQueue, playlists, playlistTracks)
    migrate.ts          ← migration runner (standalone)
    trackHistory.ts     ← room track history push/get
  routes/
    rooms.ts            ← room CRUD + sitemap + OG metadata
    playlists.ts        ← playlist CRUD + import (YouTube / Spotify / JioSaavn / Apple Music)
  ws/
    handler.ts          ← WebSocket message router + WSMessage / IncomingMessage unions
    roomManager.ts      ← RoomManager singleton (in-memory timeline, queue, members, host)

scripts/
  start.mjs             ← production start (auto-builds if dist/ missing)
```

**Room state is in-memory** (`MemoryRoomStore` + `RoomManager` singleton in `ws/roomManager.ts`). A room's timeline, queue, and member list live in process memory and are periodically synced to the `rooms` / `roomQueue` / `roomTrackHistory` tables. There is no cross-instance pub/sub — a single server process owns a room for its lifetime. If you scale horizontally you'll need to add sticky sessions or re-introduce a `Broadcaster`/`RoomStore` backed by Redis.

## API Endpoints

All `/api/*` routes (except `/api/auth/*`, `/api/search`, `/api/resolve-link`, `/api/audio/:videoId`) require authentication. Error responses use `{ error: string }` with an appropriate status code.

### Auth `GET|POST /api/auth/*`
better-auth handler. Google + Discord OAuth. Endpoints under here (sign-in, callback, sign-out, session) are generated by better-auth — see its docs for the exact paths.

### Desktop OAuth `GET /api/auth/desktop-redirect`
Reads the `better-auth.session_token` cookie and redirects to `blu3://auth-callback?token=<token>`. Used by the Electron app to complete OAuth in the browser then hand the token to the desktop shell.

### Search `GET /api/search?q=<query>`
Rate-limited (30 req/min per IP). Returns YouTube Music results mapped to a normalized track shape:
```jsonc
{ "tracks": [
  { "id": "<videoId>", "videoId": "<videoId>", "name": "...", "duration_ms": 0,
    "artists": [{ "name": "..." }], "album": { "name": "" },
    "image": "<thumbnail url>", "source": "youtube" }
]}
```

### Resolve audio `POST /api/resolve`
Auth required. Rate-limited (60 req/min per IP). Body:
```jsonc
{ "videoId": "string", "name": "string?", "artists": "string?",
  "duration": "number?", "source": "string?" }  // source: "youtube" forces YouTube path
```
Resolves a playable audio URL. Tries JioSaavn first (by numeric id or name+artist fuzzy match), then YouTube. Returns:
```jsonc
{ "source": "jiosaavn" | "youtube", "videoId": "...", "audioUrl": "/api/audio/<videoId>" }
```
When the audio URL can't be resolved directly but a YouTube match is found, returns `{ source, videoId, image? }` so the client can fall back to the YouTube IFrame player.

### Resolve link `POST /api/resolve-link`
Auth required. Rate-limited (20 req/min per IP). Body: `{ "url": "string" }`. Accepts YouTube, Spotify track, Apple Music, or any searchable URL. Resolves to a YouTube videoId + metadata, pre-warming the audio cache in the background. Returns `{ videoId, name, artist, image, source: "youtube" }`.

### Audio proxy `GET /api/audio/:videoId`
Auth required (cookie **or** `?token=<sessionToken>` query param — the query path is how the client `<audio>` element authenticates). Proxies the underlying CDN stream with `Range` support, 24h in-memory cache, and proper `Content-Range` / `Accept-Ranges` passthrough. Use this URL directly as the `src` of an `<audio>` element.

### Rooms `* /api/rooms/*`
All require auth.
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/rooms` | Create room (body: `{ name }`) |
| `GET` | `/api/rooms/sitemap` | Active public rooms (no auth) |
| `GET` | `/api/rooms/:code/og` | OG metadata: `{ hostName, hostImage, roomName }` (no auth) |
| `GET` | `/api/rooms/:code` | Get room + members |
| `POST` | `/api/rooms/:code/join` | Join room |
| `POST` | `/api/rooms/:code/leave` | Leave room |
| `DELETE` | `/api/rooms/:code` | Delete room (host only) |
| `GET` | `/api/rooms/user/mine` | User's rooms with last played track |

### Playlists `* /api/playlists/*`
All require auth.
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/playlists` | User's playlists (auto-creates "Liked Songs" on first fetch) |
| `GET` | `/api/playlists/liked/ids` | Liked track videoIds |
| `GET` | `/api/playlists/:id` | Playlist + tracks |
| `POST` | `/api/playlists` | Create blank playlist (body: `{ name }`) |
| `POST` | `/api/playlists/liked/toggle` | Like/unlike (body: `{ videoId }`) |
| `POST` | `/api/playlists/import` | Import from URL (YouTube / Spotify / JioSaavn / Apple Music) |
| `DELETE` | `/api/playlists/:id` | Delete playlist |
| `POST` | `/api/playlists/:id/tracks` | Add track |
| `DELETE` | `/api/playlists/:id/tracks/:trackId` | Remove track |
| `PUT` | `/api/playlists/:id/tracks/reorder` | Reorder tracks |

### Health
| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Always 200 |
| `GET` | `/readyz` | Probes DB + Redis; 503 `{ issues: [...] }` if degraded |

## WebSocket Protocol

Connect: `GET /ws?token=<sessionToken>&room=<ROOM_CODE>` (room code is uppercased server-side). On success you receive a `room:joined` snapshot.

### Client → Server (`IncomingMessage`)
All messages are JSON with a discriminated `type` field.
| `type` | Payload | Notes |
|---|---|---|
| `playback:play` | `{ videoId, id?, source?, trackName?, artistName?, image?, currentTime?, duration_ms? }` | Host-or-uncontrolled-only. Server computes anchor + broadcasts `play`. |
| `playback:pause` | `{ currentTime? }` | |
| `playback:seek` | `{ currentTime? }` | |
| `playback:ended` | `{ currentTime? }` | Triggers auto-advance to next queue track |
| `playback:mode` | `{ shuffle?, repeatMode? }` | `repeatMode: "off" \| "all" \| "one"` |
| `playback:sync_request` | `{}` | Server replies with `playback:sync` |
| `clock_sync_request` | `{}` | Server replies with `clock_sync` |
| `chat:send` | `{ text: string }` | Broadcasts `chat:message` |
| `queue:add` | `{ track: QueueTrack }` | Dedupes by videoId, inserts at position 1 |
| `queue:remove` | `{ trackId: string }` | |
| `queue:cycle_current` | `{ trackId: string }` | Moves a finished track to the end |
| `queue:clear` | `{}` | |
| `progress` | `{ currentTime: number }` | Client heartbeat of playback position |

### Server → Client (`WSMessage` + room events)
| `type` | Payload | When |
|---|---|---|
| `room:joined` | `{ roomCode, isHost, isHostActive, members, playback, playbackMode, recentTracks, queue }` | On connect — full state snapshot |
| `play` | `{ videoId, source, seekTo, serverTime, anchorServerTime, id?, trackName?, artistName?, image?, duration_ms?, recentTracks? }` | New track starts |
| `pause` | `{ serverTime, anchorServerTime, positionSec }` | |
| `seek` | `{ seekTo, serverTime, anchorServerTime }` | |
| `clock_sync` | `{ serverTime }` | Reply to `clock_sync_request`; also periodically pushed |
| `playback:sync` | (current playback state) | Reply to `playback:sync_request` |
| `room:playback_mode` | `{ shuffle, repeatMode }` | |
| `room:queue_update` | `{ queue: QueueTrack[] }` | After any queue mutation |
| `room:member_joined` | `{ member: MemberInfo }` | |
| `room:member_left` | `{ userId }` | |
| `host:active_changed` | `{ isHostActive: boolean }` | Host socket connects/disconnects |
| `chat:message` | `{ id, userId, name, avatar?, text, ts }` | |
| `track:preresolved` | `{ videoId, audioUrl }` | Server pre-resolved the next track's audio URL |
| `error` | `{ message: string }` | Fatal — socket is closed |

### Playback control rules
`canControlPlayback` (`ws/handler.ts`): if the host socket is active, only the host (or an `admin` role) can issue `playback:play` / `pause` / `seek` / `mode` / `ended`. If the host socket is **not** active, any member can control playback. This is what `host:active_changed` signals to the client so it can toggle its UI.

## Timeline math

Synchronized playback is anchored to server time, not client time. The client receives `play` with `anchorServerTime` (ms) + `seekTo` (sec) and computes its current position as `seekTo + (serverNow - anchorServerTime)/1000`. `src/lib/timeline.ts` is the single source of truth for this math (`currentPosition`, `effectiveElapsedMs`, `createResumeSnapshot`, `createPauseSnapshot`). If you touch sync logic, change it there — not inline in the handler.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Neon `?sslmode=require` works) |
| `BETTER_AUTH_URL` | Yes | Server base URL |
| `BETTER_AUTH_SECRET` | Yes | better-auth secret |
| `BETTER_AUTH_API_KEY` | No | better-auth admin API key |
| `FRONTEND_URL` | Yes | Comma-separated client URLs (CORS + OAuth trusted origins) |
| `CORS_ORIGINS` | No | Extra CORS origins (comma-separated) appended to the defaults |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google auth | |
| `DISCORD_CLIENT_ID` / `DISCORD_SECRET` | Discord auth | |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Rate limits | Upstash Redis; if absent, rate limiting is skipped (fail-open) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify import | Used by the playlist importer's `client_credentials` flow |
| `YOUTUBE_API_KEY` | Optional | Fallback for `ytmusic-api` when its scraped key is unavailable (data-center IPs) |
| `YTMUSIC_API_KEY` / `YTMUSIC_CLIENT_VERSION` | Optional | Alt fallback key + context for the YouTube Music client |
| `YT_COOKIES` / `YT_COOKIES_FILE` | Optional | YouTube cookies for audio extraction in restricted environments |
| `PORT` | No | Server port (default `8000`) |

## Commands

```bash
bun run dev              # tsx watch (hot reload)
bun run build            # tsc -p tsconfig.json
npx tsc --noEmit         # typecheck only
bun run start            # node scripts/start.mjs (auto-builds if dist/ missing)
bun run db:generate      # drizzle-kit generate (after schema changes)
bun run db:migrate       # tsx src/db/migrate.ts
bun run db:studio        # drizzle-kit studio (GUI)
```

## Database Schema

All tables in `src/db/schema.ts`. Key ones:
- `user`, `session`, `account`, `verification` — better-auth tables.
- `rooms` — `{ id, code, name, hostId, hostName, isActive, createdAt }`. `code` is the 6-char join code.
- `room_members` — who's in a room (hydrated from the in-memory `MemoryRoomStore`).
- `room_track_history` — played tracks (drives the "recently played" UI + `/user/mine` last track).
- `room_queue` — persisted mirror of the in-memory queue.
- `playlists` / `playlist_tracks` — user playlists; `is_liked` flag marks the auto-created "Liked Songs".

After changing `schema.ts`, run `bun run db:generate` then `bun run db:migrate`.

## Contributing

Good first issues:
- **Add an audio source** — implement a resolver in `src/lib/` mirroring `jiosaavnAudio.ts` / `ytAudio.ts` (search + URL resolution), wire it into `POST /api/resolve` in `index.ts`.
- **Add a REST route** — create a file in `src/routes/`, export a `Hono` instance, mount it in `src/index.ts`. Use the shared `requireAuth` + `AuthEnv` from `src/lib/requireAuth.ts`.
- **Add a WS message** — extend the `IncomingMessage` / `WSMessage` unions in `ws/handler.ts`, add a `case` in the message switch, broadcast the result via `broadcast(roomCode, { type: ... })`.
- **Add a DB table** — add a `pgTable` to `db/schema.ts`, generate a migration, and use the inferred type (`typeof x.$inferSelect`).

Conventions (see `AGENTS.md` for the full list):
- Import `db` from `../db/index.js` — never open a second connection.
- Load env via `src/lib/env.ts` (import it first in any entry point).
- Use `.js` extensions in all relative imports (TS ESM + NodeNext).
- No `console.log` for debugging — `console.error` for actual errors only.
- Error responses are always `{ error: string }` with a real status code.
- WS messages are typed as discriminated unions — keep them in sync with the client.

## Deployment

Render config is in `render.yaml` (Node env, `bun install --frozen-lockfile && bun run build`, `bun run start`, `/health` check path). The start script auto-builds if `dist/` is missing, so a fresh deploy works without a separate build step.
