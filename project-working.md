# blu3-server — Audio Resolution Architecture & Deployment

## Overview

blu3-server is a Hono-based collaborative music room backend. Audio playback is **not iframe-based** — we use **yt-dlp** to extract direct audio stream URLs from YouTube, cache them server-side, and proxy the stream to clients. This enables gapless playback, seeking, and real-time sync across room members.

---

## Runtime Stack

| Component | Version/Purpose |
|-----------|----------------|
| **Runtime** | Bun v1.x (production via systemd service) |
| **Framework** | Hono v4 (Node.js adapter) |
| **Database** | PostgreSQL + Drizzle ORM (Neon serverless) |
| **WebSocket** | ws library + @hono/node-server |
| **Auth** | better-auth (Google/Discord OAuth) |
| **Audio Extractor** | yt-dlp CLI (installed on server, not npm) |
| **JS Runtime for yt-dlp** | Deno (for n-challenge solving) |
| **Audio Sources** | JioSaavn (primary), YouTube via yt-dlp (fallback) |

---

## Audio Resolution Pipeline (Data Flow)

```
Client App
    │
    ├── POST /api/resolve { videoId, name, artists, duration }
    │       │
    │       ├── [1] JioSaavn (DES-decrypted CDN) ← fastest, ~200-800ms
    │       │       └── Works for Indian songs, numeric IDs
    │       │
    │       └── [2] tryYtDlp(videoId) ← yt-dlp subprocess
    │               │
    │               ├── Strategy A: web client + cookies.txt  (~8-10s on Oracle)
    │               │       └── yt-dlp --no-update --js-runtimes deno
    │               │                --cookies /root/blu3-server/cookies.txt
    │               │                -f bestaudio -g "https://youtube.com/watch?v=VIDEO_ID"
    │               │
    │               └── Strategy B: android client (no cookies)  (~4-6s)
    │                       └── yt-dlp --no-update
    │                                --extractor-args "youtube:player_client=android"
    │                                -f bestaudio -g "https://youtube.com/watch?v=VIDEO_ID"
    │
    └── Returns { source:"ytdlp", videoId, audioUrl:"/api/audio/VIDEO_ID" }
                                                    │
                                                    ▼
    GET /api/audio/:videoId?token=JWT
        │
        ├── Checks in-memory audioCache (24h TTL, cleaned every 5min)
        ├── If cold: calls resolveAudioUrl() → tryYtDlp()
        ├── Fetches CDN URL with Range headers (seeking support)
        └── Proxies stream to client (206 Partial Content)

    Also: WebSocket for real-time sync
        └── ws://api.blu3.in/ws?token=JWT&room=CODE
            ├── playback:play / pause / seek / ended
            ├── queue:add / remove / cycle_current / clear
            ├── chat:send
            └── clock_sync (timestamp offset calculation)
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry — routes, audio resolution, proxy, yt-dlp integration |
| `src/lib/jiosaavnAudio.ts` | JioSaavn search + DES-decrypted CDN URL extraction |
| `src/lib/ytAudio.ts` | ytmusic-api search (for metadata only, not audio extraction) |
| `src/ws/handler.ts` | WebSocket message handler (playback state machine) |
| `cookies.txt` | Firefox-exported YouTube cookies (Netscape format) |
| `scripts/start.mjs` | Production startup script (auto-builds if dist missing) |

---

## tryYtDlp() — Three-Strategy Audio Extraction

Located at `src/index.ts:404`.

```typescript
function tryYtDlp(videoId: string): string | null {
  // Strategy 1: android client (fast, no n-challenge, no cookies)
  execSync(`yt-dlp --no-update --extractor-args "youtube:player_client=android" -f bestaudio -g "..."`, { timeout: 20000 })

  // Strategy 2: tv_downgraded + WARP proxy (bypasses Oracle IP + SABR)
  execSync(`yt-dlp --proxy socks5://127.0.0.1:1080 --no-update --extractor-args "youtube:player_client=tv_downgraded" -f bestaudio -g "..."`, { timeout: 30000 })

  // Strategy 3: web + cookies (best quality, for non-datacenter)
  execSync(`yt-dlp --no-update --js-runtimes deno --cookies /path/to/cookies.txt -f bestaudio -g "..."`, { timeout: 15000 })
}
```

**Why three strategies?**
- **Strategy 1 (android)**: YouTube's mobile API — no n-challenge, no cookies needed. Works on most IPs directly (~128kbps).
- **Strategy 2 (tv_downgraded + WARP)**: YouTube TV client routed through Cloudflare WARP. Avoids SABR streaming experiment and works on Oracle Cloud IPs. **This is the primary working strategy on datacenter IPs.**
- **Strategy 3 (web + cookies)**: Full desktop client with authenticated session. Best quality but fails on datacenter IPs. Requires fresh cookies.

---

## Cookies.txt Setup

### Why Firefox?
Chrome v127+ encrypts cookies with an "app-bound" key. Only Chrome.exe can read them. Firefox stores cookies in a plain SQLite database that yt-dlp can access.

### Export cookies (one-time setup on local machine):
```powershell
# PowerShell on Windows — exports ALL cookies including HttpOnly (SID, HSID, etc.)
yt-dlp --cookies-from-browser firefox --cookies cookies.txt
```

### Verify cookies.txt has the right content:
```bash
grep -c "SID\|__Secure-1PSID\|HSID" cookies.txt
# Should output >= 3 (these are the critical auth cookies)
```

The file must start with the Netscape header:
```
# Netscape HTTP Cookie File
# https://curl.haxx.se/rfc/cookie_spec.html
# This is a generated file! Do not edit.
```

### Deploy to server:
```bash
scp cookies.txt root@<oracle-ip>:/root/blu3-server/cookies.txt
```

**Important**: Cookies expire every few weeks. YouTube rotates them. Re-export and re-upload when you see:
```
WARNING: [youtube] The provided YouTube account cookies are no longer valid.
```

---

## Oracle Cloud / Datacenter IP Workaround

YouTube blocks datacenter IP ranges (Oracle Cloud, AWS, GCP, etc.) at the network level. Symptoms:
- `"Sign in to confirm you're not a bot"` even with valid cookies
- `"n challenge solving failed"`
- `"Only images are available for download"`

### Three-layer defense in tryYtDlp

| Layer | Strategy | Location | Purpose |
|-------|----------|----------|---------|
| 1 | android client (direct) | No proxy needed | Fastest, no cookies, no JS challenge |
| 2 | android + WARP SOCKS5 | `socks5://127.0.0.1:1080` | When Oracle IP is flagged |
| 3 | web + cookies | Local cookies.txt | Best quality, for non-datacenter |

### WARP Proxy Setup (Step-by-Step)

This is the permanent fix for datacenter IP blocking. Run these commands on the **Oracle Cloud server**:

#### 1. Download wireproxy
```bash
# wireproxy — userspace WireGuard client (no root/NET_ADMIN needed)
curl -fsSL -o /usr/local/bin/wgcf \
  "https://github.com/ViRb3/wgcf/releases/download/v2.2.22/wgcf_2.2.22_linux_amd64"
chmod +x /usr/local/bin/wgcf
```

#### 2. Register free Cloudflare WARP account
```bash
wgcf register --accept-tos
wgcf generate
```
This creates two files: `wgcf-account.toml` and `wgcf-profile.conf`.

#### 3. Add SOCKS5 proxy to the WireGuard config
```bash
cat >> wgcf-profile.conf << 'EOF'

[Socks5]
BindAddress = 127.0.0.1:1080
EOF
```

#### 4. Download and run wireproxy
```bash
# Download wireproxy binary
curl -fsSL -o /tmp/wireproxy.tar.gz \
  "https://github.com/pufferffish/wireproxy/releases/download/v1.0.9/wireproxy_1.0.9_linux_amd64.tar.gz"
tar -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin/
chmod +x /usr/local/bin/wireproxy

# Start it (runs in background)
wireproxy -c wgcf-profile.conf &
```

#### 5. Verify the proxy works
```bash
curl --socks5 127.0.0.1:1080 https://www.youtube.com -I
# Should return HTTP/2 200
```

#### 6. (Optional) Run wireproxy as a systemd service
Create `/etc/systemd/system/wireproxy.service`:
```ini
[Unit]
Description=Cloudflare WARP SOCKS5 Proxy
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/usr/local/bin/wireproxy -c /root/wgcf-profile.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable wireproxy
sudo systemctl start wireproxy
sudo systemctl status wireproxy
```

#### 7. Test yt-dlp through WARP
```bash
yt-dlp --proxy socks5://127.0.0.1:1080 --extractor-args "youtube:player_client=android" \
  -f bestaudio -g "https://youtube.com/watch?v=dQw4w9WgXcQ"
```

If this returns an audio URL, the WARP proxy works. The `tryYtDlp` function in `src/index.ts` already includes this as Strategy 2.

#### Docker alternative (if Docker is installed)
```bash
docker run -d --name warp-socks --restart always -p 1080:1080 \
  ghcr.io/mon-ius/docker-warp-socks:v5
```
```

**Docker alternative** (if Docker is available):
```bash
docker run -d -p 1080:1080 ghcr.io/kingcc/warproxy:latest
```

---

## Deno Setup for n-Challenge Solving

yt-dlp needs a JavaScript runtime to solve YouTube's "n" parameter challenge. Deno is recommended for 1GB RAM VMs (lighter than Node.js).

### Install Deno:
```bash
curl -fsSL https://deno.land/install.sh | sh
```

### Add to PATH in systemd service:
Edit `/etc/systemd/system/blu3-server.service`:
```ini
[Service]
Environment=PATH=/root/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl restart blu3-server
```

Verify Deno is found:
```bash
sudo systemctl show blu3-server -p Environment
# or check logs for "No supported JavaScript runtime could be found"
```

---

## Systemd Service Setup

```bash
# Service file location: /etc/systemd/system/blu3-server.service
sudo systemctl start blu3-server
sudo systemctl stop blu3-server
sudo systemctl restart blu3-server
sudo systemctl status blu3-server
```

Full service file:
```ini
[Unit]
Description=blu3-server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/blu3-server
ExecStart=/usr/local/bin/bun run start
Environment=PATH=/root/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## API Endpoints (Audio-Related)

| Method | Path | Auth | Purpose | Time |
|--------|------|------|---------|------|
| `POST` | `/api/resolve` | Required | Resolve audio URL for a track | 400ms-15s |
| `GET` | `/api/audio/:videoId` | Required | Proxy audio stream (with Range) | 200-400ms |
| `POST` | `/api/piped-resolve` | No | yt-dlp URL extraction (testing) | 4-15s |
| `GET` | `/api/search?q=` | Rate-limited | Search YouTube Music | 1-3s |
| `POST` | `/api/resolve-link` | Required | Resolve YouTube/Spotify/Apple Music link | 1-8s |

### `POST /api/resolve` — Response Shapes

**Success — JioSaavn**
```json
{ "source": "jiosaavn", "videoId": "12345", "audioUrl": "/api/audio/12345" }
```

**Success — yt-dlp**
```json
{ "source": "ytdlp", "videoId": "dQw4w9WgXcQ", "audioUrl": "/api/audio/dQw4w9WgXcQ" }
```

**Fallback (no audio URL, only metadata)**
```json
{ "source": "youtube", "videoId": "dQw4w9WgXcQ", "image": "https://..." }
```

### `GET /api/audio/:videoId` — Audio Proxy

Headers forwarded: `content-type`, `content-length`, `content-range`, `accept-ranges`
Cache: `Cache-Control: private, max-age=3600`
Auth: Session cookie or `?token=` query param

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `rooms` | Collaborative music rooms |
| `room_members` | Room membership |
| `room_track_history` | Recently played (max 10 per room) |
| `room_queue` | Persistent queue per room |
| `playlists` | User playlists (auto-creates "Liked Songs") |
| `playlist_tracks` | Tracks within playlists |

---

## Performance Notes

| Scenario | Latency | Details |
|----------|---------|---------|
| JioSaavn match | 200-800ms | Best case — Indian songs, numeric videoIds |
| yt-dlp android (direct) | 4-6s | Oracle Cloud, ~128kbps, no cookies |
| yt-dlp tv_downgraded + WARP | 4-8s | Primary working strategy on datacenter IPs |
| yt-dlp web + cookies | 2-5s | Only works with fresh cookies + non-datacenter IP |
| Total resolve + stream | 4.5-14s | Depends on source and fallbacks |
| Cached (24h) | 200-400ms | After first resolve per videoId

---

## Troubleshooting

### "cookies.txt does not look like a Netscape format cookies file"
- File is missing `# Netscape HTTP Cookie File` header
- Or has Windows CRLF line endings instead of Unix LF
- Fix: `yt-dlp --cookies-from-browser firefox --cookies cookies.txt`

### "No supported JavaScript runtime could be found"
- Deno not installed, or not on PATH in systemd service
- Fix: Install Deno + add `Environment=PATH=` to systemd unit

### "Sign in to confirm you're not a bot"
- Cookies expired or Oracle Cloud IP flagged
- Re-export cookies from Firefox → upload to server
- If still failing, try android client (no cookies needed)
- If android also fails after 2-3 songs, set up WARP proxy (Strategy 2)

### "n challenge solving failed"
- YouTube's anti-bot challenge can't be solved on datacenter IP
- Fix: Try android client, which doesn't require n-challenge

### "Requested format is not available"
- All attempted clients/formats failed to extract audio
- Fix: Try different player_client (android, tv_downgraded, etc.)

### "Only images are available for download"
- YouTube returned only thumbnail/storyboard formats
- Fix: Use android client or WARP proxy

### ETIMEDOUT (15s+)
- yt-dlp hanging on first strategy before falling back
- Fix: Try android first (faster), reduce timeout on failing strategy

---

## Common Commands

```bash
# Test yt-dlp manually on server
yt-dlp --no-update --extractor-args "youtube:player_client=android" -f bestaudio -g "https://youtube.com/watch?v=dQw4w9WgXcQ"

# With cookies
yt-dlp --no-update --js-runtimes deno --cookies /root/blu3-server/cookies.txt -f bestaudio -g "https://youtube.com/watch?v=dQw4w9WgXcQ"

# Through WARP proxy
yt-dlp --proxy socks5://127.0.0.1:1080 --no-update --extractor-args "youtube:player_client=android" -f bestaudio -g "https://youtube.com/watch?v=dQw4w9WgXcQ"

# Test WARP proxy
curl --socks5 127.0.0.1:1080 https://www.youtube.com -I

# Test audio proxy
curl -o /dev/null -w "%{http_code} %{time_total}s" "http://localhost:8000/api/audio/dQw4w9WgXcQ?token=JWT_TOKEN"

# View logs
sudo journalctl -u blu3-server -f

# View WARP logs
sudo journalctl -u wireproxy -f
```
