# blu3-server

Real-time collaborative music room API. Built with [Hono](https://hono.dev/), [Drizzle ORM](https://orm.drizzle.team/), [better-auth](https://www.better-auth.com/), and [Upstash Redis](https://upstash.com/).

## Quick Start

```bash
# install
bun install

# copy env
cp .env.example .env
# edit .env with your secrets

# run migrations
bun run db:migrate

# start dev
bun run dev
```

## Architecture

```
src/
  index.ts              ← Server entry: CORS, routes, WS upgrade, inline routes
  lib/
    env.ts              ← dotenv loader (import once at any entry point)
    auth.ts             ← better-auth setup + session helper
    broadcaster.ts      ← LocalBroadcaster / RedisPubSubBroadcaster
    crypto.ts           ← AES-256-GCM encrypt/decrypt
    jiosaavnAudio.ts    ← JioSaavn API search + CDN URL resolution
    ratelimit.ts        ← Redis-backed sliding-window rate limiter
    redis.ts            ← Upstash Redis client + in-memory fallback cache
    responseCache.ts    ← Simple TTL in-memory response cache
    roomStore.ts        ← RoomStore interface + MemoryRoomStore + RedisRoomStore
    timeline.ts         ← Timeline snapshot math (currentPosition, etc.)
  db/
    index.ts            ← Drizzle db instance (neon-http)
    schema.ts           ← All pgTable definitions
    migrate.ts          ← Migration runner (standalone)
    trackHistory.ts     ← Room track history push/get
  routes/
    rooms.ts            ← Room CRUD
    playlists.ts        ← Playlist CRUD + import (YouTube/Spotify/JioSaavn/Apple Music)
  ws/
    handler.ts          ← WebSocket message router
    roomManager.ts      ← RoomManager class + legacy singleton wrappers
    presence.ts         ← PresenceManager (heartbeat)

scripts/
  start.mjs             ← Production start script (auto-builds if dist missing)
```

## API Endpoints

### Auth `GET|POST /api/auth/*`
Handled by better-auth. Supports Google and Discord OAuth.

### Rooms `GET|POST|DELETE /api/rooms/*`
- `POST /api/rooms` — Create room (auth required)
- `GET /api/rooms/:code` — Get room + members
- `POST /api/rooms/:code/join` — Join room
- `POST /api/rooms/:code/leave` — Leave room
- `DELETE /api/rooms/:code` — Delete room (host/admin only)
- `GET /api/rooms/user/mine` — User's rooms with last track

### Playlists `GET|POST|DELETE /api/playlists/*`
- `GET /api/playlists` — User's playlists (auto-creates Liked Songs)
- `GET /api/playlists/liked/ids` — Liked track IDs
- `GET /api/playlists/:id` — Playlist with tracks
- `POST /api/playlists` — Create blank playlist
- `POST /api/playlists/liked/toggle` — Like/unlike a track
- `POST /api/playlists/import` — Import playlist via URL (YouTube, Spotify, JioSaavn, Apple Music)
- `DELETE /api/playlists/:id` — Delete playlist
- `DELETE /api/playlists/:id/tracks/:trackId` — Remove track
- `POST /api/playlists/:id/tracks` — Add track
- `PUT /api/playlists/:id/tracks/reorder` — Reorder tracks

### Audio `GET|POST /api/*`
- `GET /api/search?q=` — Search JioSaavn tracks
- `POST /api/resolve` — Resolve audio URL for a video
- `GET /api/audio/:videoId` — Proxy audio stream (authenticated)
- `GET /api/suggest` — Suggestions (stub)

### WebSocket `/ws?token=&room=`
Messages handled:
- `playback:play`, `playback:pause`, `playback:seek`, `playback:ended`, `playback:mode`, `playback:sync_request`
- `chat:send`
- `queue:add`, `queue:remove`, `queue:cycle_current`, `queue:clear`

### Health
- `GET /healthz` — Always returns 200
- `GET /readyz` — Checks DB + Redis connectivity

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Neon) |
| `BETTER_AUTH_URL` | Yes | Server base URL for better-auth |
| `BETTER_AUTH_SECRET` | Yes | better-auth secret key |
| `GOOGLE_CLIENT_ID` | For Google auth | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | For Google auth | Google OAuth client secret |
| `DISCORD_CLIENT_ID` | For Discord auth | Discord OAuth client ID |
| `DISCORD_SECRET` | For Discord auth | Discord OAuth client secret |
| `FRONTEND_URL` | Yes | Comma-separated frontend URLs for CORS |
| `CORS_ORIGINS` | No | Additional CORS origins (comma-separated) |
| `UPSTASH_REDIS_REST_URL` | For rate limits | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | For rate limits | Upstash Redis REST token |
| `SPOTIFY_CLIENT_ID` | For Spotify import | Spotify API client ID |
| `SPOTIFY_CLIENT_SECRET` | For Spotify import | Spotify API client secret |
| `CRYPTO_KEY` | No | Encryption key (default: blu3-default-key-change-me) |
| `PORT` | No | Server port (default: 8000) |

## Commands

```bash
bun run dev              # development with watch
bun run build            # TypeScript compilation
bun run start            # production start
bun run db:generate      # generate Drizzle migrations
bun run db:migrate       # run pending migrations
bun run db:studio        # Drizzle Studio (GUI)
```

## Deployment

Deploys via Render (see `render.yaml`). The start script auto-builds if `dist/` is missing.

```bash
bun install --frozen-lockfile
bun run build
bun run start
```
