# RTMP Squid

Stream a folder of video files to any RTMP server — AngelThump, Twitch, YouTube, or anything else — as a continuous 24/7 broadcast that never drops the connection between files.

Point it at a folder of movies, set your RTMP URL and stream key, and click **Go Live**. It builds an auto-refilling random queue and feeds every file through a single persistent encoder, so the stream stays up even between videos. A standby slate covers any gap.

## Features

- **Never-stopping stream** — one persistent encoder holds the RTMP connection for the whole session. Files are piped through a FIFO one after another, so the connection is never dropped between videos.
- **Auto-filling queue** — point it at a folder and it builds an endless random queue. Drag to reorder, remove, search, or shuffle.
- **Wide format support** — H.264/HEVC, VP8/VP9, and AV1 sources in most containers are normalised to H.264/AAC automatically.
- **Token auth** — every API and socket connection requires an access token.
- **Filesystem confinement** — all browsing, scanning, and streaming is restricted to one configurable media directory.

## Requirements

- Linux or macOS
- Node.js 18+
- FFmpeg 4.0+ with `libx264` and `aac` (plus an AV1 decoder such as `libdav1d` for AV1 sources)

`setup.sh` will install Node and FFmpeg for you if they're missing.

## Install

```bash
git clone <repo-url> rtmpsquid
cd rtmpsquid
./setup.sh
```

`setup.sh` is idempotent — safe to re-run any time. It verifies Node and FFmpeg, installs dependencies, builds the web client, writes a `.env` with a freshly generated `AUTH_TOKEN`, and creates your media directory. On Linux with systemd it also installs and starts a `rtmpsquid` service that auto-starts on boot and restarts on crash.

To skip the service and start manually instead: `./setup.sh --no-service`.

## Running it

With the systemd service (the default on Linux):

```bash
systemctl status rtmpsquid       # check it
journalctl -u rtmpsquid -f       # follow logs
systemctl restart rtmpsquid      # apply .env changes
```

Manually (macOS, or after `--no-service`):

```bash
npm start
```

### Docker

Prefer containers? See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the Docker / Docker Compose setup — FFmpeg is bundled in the image, so there's no host-level dependency beyond Docker.

### Uninstall

```bash
./uninstall.sh            # stop the app + remove the systemd service (keeps files & media)
./uninstall.sh --purge    # also delete node_modules, the client build, and .env
./uninstall.sh --media    # also delete the media library (asks first)
```

Idempotent, and discovers the install location from the service, so it works whatever directory/user it was installed under.

## Reaching the dashboard

The server binds to `127.0.0.1` by default. Tunnel in over SSH:

```bash
ssh -L 3001:127.0.0.1:3001 youruser@your-server
# then open http://localhost:3001 and paste the AUTH_TOKEN from .env
```

For public access, front it with a TLS reverse proxy (nginx/Traefik examples are in DEPLOYMENT.md), set `HOST` and `ALLOWED_ORIGINS` accordingly, and restart.

## Usage

1. Put your movies in a folder under `MEDIA_ROOT`.
2. Open **⚙ Settings → Movie library**, **Browse** to that folder, and click **Use this folder**. A random queue fills automatically.
3. In **⚙ Settings → Destination**, set your RTMP URL and stream key (remembered for next time).
4. Click **● Go Live**. The Now Playing bar shows the current movie, elapsed time, and what's next. It plays forever, refilling itself.

Drag tracks to reorder, ✕ to remove, search to find one, **🔀 Shuffle** to rebuild the queue.

## Configuration

Config lives in `.env` (copy from `.env.example`; `setup.sh` writes one for you). Edit it and restart. A real environment variable always overrides the file.

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_TOKEN` | *(generated)* | Access token gating all API + socket access |
| `MEDIA_ROOT` | `<repo>/media` | The only directory the app may browse, scan, or stream |
| `LIBRARY_DIR` | = `MEDIA_ROOT` | Folder the auto-queue pulls random movies from |
| `MIN_MOVIE_MB` | `5` | Ignore video files smaller than this (skips samples/junk) |
| `QUEUE_MIN` | `5` | Refill the queue when fewer than this many remain |
| `QUEUE_TARGET` | `20` | Top the queue up to this many on refill |
| `HOST` | `127.0.0.1` | Bind address (keep loopback unless behind a TLS proxy) |
| `PORT` | `3001` | Listen port |
| `ALLOWED_ORIGINS` | localhost 3000/3001/5173 | CORS / socket.io allow-list (comma-separated) |
| `SCAN_MAX_DEPTH` | `12` | Recursive scan depth limit |

## How the continuous stream works

```
playlist file → feeder ffmpeg (normalise → H.264/AAC MPEG-TS) ─┐
   next file  → feeder ffmpeg ────────────────────────────────┤→ FIFO → streamer ffmpeg (-c copy) → RTMP
 standby slate → feeder ffmpeg ────────────────────────────────┘     (one persistent connection)
```

The streamer starts once and never restarts (with bounded auto-reconnect if the platform drops it). Short-lived feeders normalise each source to identical H.264/AAC parameters and write into the FIFO; a held write handle means the streamer never sees end-of-file between files. The standby slate keeps the stream live during any gap.

## Supported formats

`.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.flv`, `.wmv`, `.m4v`, `.mpg`, `.mpeg`, `.3gp`, `.ts`, `.m2ts`, `.ogv` — including AV1, H.264/HEVC, and VP8/VP9 video.

## RTMP targets

Defaults to `rtmp://ingest.angelthump.com/live`. Also works with Twitch (`rtmp://live.twitch.tv/app`), YouTube (`rtmp://a.rtmp.youtube.com/live2`), or any RTMP(S) ingest. Only `rtmp://` and `rtmps://` targets are accepted.

## Security

- All `/api/*` (except `/api/ping`) and all socket connections require a bearer token.
- Every user-supplied path is resolved and confined to `MEDIA_ROOT` (symlinks and `..` traversal are rejected).
- Stream targets are restricted to `rtmp://`/`rtmps://`, so ffmpeg can't be coerced into writing local files.
- ffmpeg is spawned with argument arrays (no shell), so paths can't inject commands.
- `helmet` headers, CORS allow-list, rate limiting, scan depth/symlink guards, and loopback binding by default.

> The bundled Vite dev server has a known moderate advisory (esbuild GHSA-67mh-4wv8-2f99) that affects only `npm run dev`, not the production build. Keep dev on localhost.

## Development

```bash
npm run dev              # server + client with hot reload
cd client && npm test    # client unit tests (vitest)
```

## Troubleshooting

- **Can't log in** — check `.env` for the `AUTH_TOKEN`, or the service logs (`journalctl -u rtmpsquid`).
- **"Access denied / outside the media directory"** — the path isn't under `MEDIA_ROOT`.
- **Stream won't start** — verify the RTMP URL/key and that FFmpeg is on `PATH` with `libx264`.

## License

MIT
</content>
</invoke>
