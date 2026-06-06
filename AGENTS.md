<!-- BEGIN:blu3-server-agent-rules -->
# blu3-server Agent Rules

## Stack
- Runtime: Bun (v1.x+)
- Framework: Hono (Node.js adapter)
- Database: PostgreSQL + Drizzle ORM (neon-http driver)
- Auth: better-auth + drizzle adapter
- WebSocket: ws library + @hono/node-server
- Cache: Upstash Redis + in-memory fallback
- Audio: JioSaavn API (scraped)

## Commands
```bash
# development
bun run dev                    # tsx watch src/index.ts

# build & typecheck
bun run build                  # tsc -p tsconfig.json
npx tsc --noEmit               # typecheck only

# database
bun run db:generate            # drizzle-kit generate
bun run db:migrate             # tsx src/db/migrate.ts
bun run db:studio              # drizzle-kit studio

# start production
bun run start                  # node scripts/start.mjs
```

## Code Conventions
- **Imports order**: (1) env.ts, (2) std lib, (3) framework/deps, (4) internal modules (../lib, ../db, ../routes, ../ws), (5) types
- **No inline comments** — exceptions: section headers (`// ── Section ──`), route descriptions (`// POST /api/...`)
- **No console.log debug statements** — use `console.error` for actual errors
- **Error responses**: always return `{ error: string }` with appropriate status codes
- **Env vars**: loaded once via `src/lib/env.ts` — never call `dotenv.config()` elsewhere
- **DB**: import `db` from `../db/index.js` — never create a second connection
- **WS messages**: typed as discriminated unions (`{ type: "...", ... }`)
- **Routes**: each route file exports a Hono instance; mounted in `src/index.ts`
- **File extensions**: use `.js` extension in all relative imports (TypeScript ESM convention with NodeNext)

## Architecture
```
src/
  index.ts              ← server entry (CORS, routes mount, WS upgrade, inline routes)
  lib/
    env.ts              ← dotenv loader (import first in any entry point)
    auth.ts             ← better-auth setup + getSessionFromRequest
    broadcaster.ts      ← LocalBroadcaster / RedisPubSubBroadcaster
    crypto.ts           ← AES-256-GCM encrypt/decrypt
    jiosaavnAudio.ts    ← JioSaavn API search + URL resolution
    ratelimit.ts        ← Redis-backed sliding window rate limiter
    redis.ts            ← Upstash Redis client + in-memory fallback cache
    responseCache.ts    ← simple TTL-based in-memory response cache
    roomStore.ts        ← RoomStore interface + MemoryRoomStore + RedisRoomStore
    timeline.ts         ← timeline snapshot math (currentPosition, etc.)
  db/
    index.ts            ← drizzle db instance
    schema.ts           ← all pgTable definitions
    migrate.ts          ← migration runner (standalone)
    trackHistory.ts     ← room track history push/get
  routes/
    rooms.ts            ← room CRUD routes
    playlists.ts        ← playlist CRUD + import routes
  ws/
    handler.ts          ← WebSocket message handler
    roomManager.ts      ← RoomManager class + legacy singleton wrappers
    presence.ts         ← PresenceManager (heartbeat)
```
<!-- END:blu3-server-agent-rules -->
