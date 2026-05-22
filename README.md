# RTMP Squid

Web app for streaming video playlists to RTMP servers (AngelThump, Twitch, YouTube, …) as a **continuous 24/7 stream that never stops**.

## What's new

- **One auto-filling queue (VLC-simple).** Point it at a movie folder and it builds a never-ending random queue. As movies play they drop off the top; when fewer than 5 remain it auto-refills with more random picks. Drag to reorder, remove, search — then it just plays.
- **Never-stopping stream.** A single persistent encoder holds the RTMP connection for the whole session. Movies are fed through a FIFO pipe one after another, so the connection is **never dropped between files**. During any gap a **standby slate** keeps the stream live.
- **AV1 source files.** AV1-encoded inputs (in `.mp4`/`.mkv`/`.webm`) are decoded and transcoded to H.264 for the RTMP target. Mixed-codec / mixed-resolution / mixed-fps movies are normalised automatically.
- **Authentication.** Every API + socket connection requires an access token.
- **Filesystem confinement.** All browsing, scanning and streaming is restricted to a single configurable media directory.

## How the continuous stream works

```
playlist file → feeder ffmpeg (normalise → H.264/AAC MPEG-TS) ─┐
        next file → feeder ffmpeg ────────────────────────────┤→ FIFO → streamer ffmpeg (-c copy) → RTMP
        standby slate → feeder ffmpeg ──────────────────────────┘     (one persistent connection)
```

- The **streamer** is started once and never restarts (with bounded auto-reconnect if the platform drops it).
- **Feeders** are short-lived: one per file, plus a slate generator for idle periods. Each normalises its source to identical H.264/AAC parameters (`-bf 0` keeps timestamps monotonic across boundaries).
- A held FIFO write handle means the streamer never sees end-of-file between feeders.

## Requirements

- Node.js 18+
- FFmpeg 4.0+ with `libx264`, `aac`, and (for AV1 inputs) an AV1 decoder such as `libdav1d`

## Install (one command)

```bash
./setup.sh        # or: npm run setup
```

`setup.sh` is idempotent and does everything:
- verifies Node ≥ 18 and FFmpeg with `libx264` (offers to install what's missing),
- installs server + client dependencies and **builds the client**,
- writes a `.env` with a freshly generated `AUTH_TOKEN` and sensible defaults,
- creates your media directory,
- prints the token and the exact SSH-tunnel command.

Then start it:

```bash
npm start          # serves UI + API on 127.0.0.1:3001 (config from .env)
```

### Run it forever (auto-start on boot, auto-restart on crash)

```bash
./setup.sh --service     # installs + enables a systemd service named "rtmpsquid"
# manage with: systemctl {status,restart,stop} rtmpsquid
```

### Reaching the dashboard

The server binds to **127.0.0.1** by default. Tunnel in:

```bash
ssh -L 3001:127.0.0.1:3001 youruser@your-server
# then open http://localhost:3001 and paste the AUTH_TOKEN from .env
```

Config lives in `.env` (see `.env.example`); edit it and restart. A real environment
variable always overrides the file. For local development with hot reload: `npm run dev`.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_TOKEN` | *(generated)* | Access token gating all API + socket access |
| `MEDIA_ROOT` | `<repo>/media` | Only directory the app may browse/scan/stream into |
| `LIBRARY_DIR` | = `MEDIA_ROOT` | Folder the auto-queue pulls random movies from (scanned recursively) |
| `MIN_MOVIE_MB` | `5` | Ignore video files smaller than this (skips samples/junk) |
| `QUEUE_MIN` | `5` | Refill the queue when fewer than this remain |
| `QUEUE_TARGET` | `20` | Top the queue up to this many on refill |
| `HOST` | `127.0.0.1` | Bind address (keep loopback unless fronted by a TLS proxy) |
| `PORT` | `3001` | Listen port |
| `ALLOWED_ORIGINS` | localhost:3000/3001/5173 | CORS / socket.io allow-list |
| `SCAN_MAX_DEPTH` | `12` | Recursive scan depth limit |

## Usage

1. Put your movies in a folder under `MEDIA_ROOT`.
2. Open **⚙ Settings → Movie library**, **Browse** to that folder, and **Use this folder**. A random queue fills automatically.
3. Drag tracks to reorder, ✕ to remove, search to find one. **🔀 Shuffle** rebuilds a fresh random queue.
4. In **⚙ Settings → Destination** set your RTMP URL + stream key (remembered for next time).
5. **● Go Live** — the Now Playing bar shows the current movie, elapsed time, what's next, and a *STANDBY* badge if the slate ever fills a gap. It plays forever, refilling itself.

## Supported source formats

`.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.flv`, `.wmv`, `.m4v`, `.mpg`, `.mpeg`, `.3gp`, `.ts`, `.m2ts`, `.ogv` — including AV1, H.264/HEVC, VP8/VP9 video.

## RTMP services

Default: `rtmp://ingest.angelthump.com/live`. Also works with Twitch (`rtmp://live.twitch.tv/app`), YouTube (`rtmp://a.rtmp.youtube.com/live2`), or any RTMP(S) ingest. Only `rtmp://` / `rtmps://` targets are accepted.

## Security model

- All `/api/*` (except `/api/ping`) and all socket connections require a bearer token.
- Every user-supplied path is resolved and confined to `MEDIA_ROOT` (symlinks and `..` traversal rejected).
- Stream targets are restricted to `rtmp://`/`rtmps://` (prevents ffmpeg from being coerced into writing local files).
- ffmpeg is spawned with argument arrays (no shell), so file paths can't inject commands.
- `helmet` security headers, CORS allow-list, rate limiting, recursive-scan depth/symlink guards, loopback binding.

> Note: the bundled Vite dev server has a known moderate advisory (esbuild GHSA-67mh-4wv8-2f99) that only affects `npm run dev`, not the production build. Keep dev on localhost.

## Troubleshooting

- **Can't log in:** check the server logs for the generated `AUTH_TOKEN`, or set one explicitly.
- **"Access denied / outside the media directory":** the path isn't under `MEDIA_ROOT`.
- **Stream won't start:** verify the RTMP URL/key and that FFmpeg is on `PATH`.

## License

MIT
