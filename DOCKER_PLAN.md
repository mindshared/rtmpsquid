# RTMP Squid Docker Implementation

Technical documentation for the Docker deployment of RTMP Squid.

---

## Overview

RTMP Squid is a web application for streaming video playlists to RTMP servers as a continuous 24/7 stream.

**Key Features:**
- Auto-filling queue from media folders
- Persistent RTMP stream via FIFO pipes
- AV1 source support (transcoded to H.264 for RTMP)
- Token-based authentication
- Filesystem confinement to MEDIA_ROOT

**Tech Stack:**
- Backend: Node.js 18+, Express, Socket.IO
- Frontend: React 18, Vite
- Media Processing: FFmpeg (libx264, aac, libdav1d for AV1)

---

## Docker Architecture

### Multi-Stage Build

The Dockerfile uses a two-stage build to optimize image size:

```
Stage 1: Client Builder (Node 18 Alpine)
  - Build React/Vite frontend
  - Output: static files in client/dist
  - Discarded after build

Stage 2: Runtime Image (Node 18 Slim)
  - Copy server code
  - Copy built client from Stage 1
  - Install FFmpeg with required codecs
  - Set up non-root user
```

**Base Image Choice:**
- **node:18-slim** (Debian-based): Better FFmpeg codec support, easier libdav1d installation
- Smaller than full Debian but includes necessary system libraries
- ~200MB final image size

---

## Build Process

### Stage 1: Client Build

```dockerfile
FROM node:18-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build
```

- Uses Alpine for minimal build environment
- Installs only client dependencies
- Produces optimized production build
- Output: `client/dist/` directory

### Stage 2: Runtime

```dockerfile
FROM node:18-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy application
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY --from=client-builder /app/client/dist ./client/dist

# Run as non-root
USER node

# Environment defaults
ENV HOST=0.0.0.0 \
    PORT=3001 \
    MEDIA_ROOT=/media \
    LIBRARY_DIR=/media/library

EXPOSE 3001
CMD ["node", "server/index.js"]
```

---

## Security Considerations

### Non-Root User

- Container runs as `node` user (UID/GID 1000)
- Pre-existing in node:18-slim base image
- No additional user creation needed
- Prevents privilege escalation

### Filesystem Isolation

- Application enforces MEDIA_ROOT confinement
- Read-only .env mount prevents tampering
- Media directory can be mounted read-only if desired

### Authentication

- AUTH_TOKEN required for all dashboard/API/socket access
- Token should be cryptographically random (16+ bytes)
- Stored in .env file with 600 permissions

### Network Security

- Binds to 0.0.0.0 for container networking
- Use reverse proxy with TLS for production
- CORS protection via ALLOWED_ORIGINS

---

## Volume Strategy

### Media Files

```yaml
volumes:
  - ./data/media:/media
```

- Bind mount for direct filesystem access
- Allows easy media management outside container
- Can be NFS/network mount for centralized storage
- Recommended: Use subdirectories for organization

### Configuration

```yaml
volumes:
  - ./.env:/app/.env:ro
```

- Read-only mount prevents modification
- Single source of truth for configuration
- Easy to update without rebuilding image

---

## Environment Configuration

### Required Variables

| Variable | Purpose | Example |
|----------|---------|----------|
| `AUTH_TOKEN` | Dashboard authentication | `a1b2c3d4e5f6...` |
| `HOST` | Server bind address | `0.0.0.0` |
| `PORT` | Server port | `3001` |
| `MEDIA_ROOT` | Media directory root | `/media` |
| `LIBRARY_DIR` | Auto-queue source | `/media/library` |

### Optional Variables

| Variable | Default | Purpose |
|----------|---------|----------|
| `ALLOWED_ORIGINS` | `http://localhost:3001` | CORS whitelist |
| `SCAN_MAX_DEPTH` | `12` | Directory scan depth |
| `QUEUE_MIN` | `5` | Min queue before refill |
| `QUEUE_TARGET` | `20` | Target queue size |
| `MIN_MOVIE_MB` | `5` | Minimum file size filter |

---

## Resource Requirements

### Minimum Specifications

- **CPU**: 1 core
- **RAM**: 512 MB
- **Storage**: 10 GB (plus media)
- **Network**: 5 Mbps upload

### Recommended Specifications

- **CPU**: 2+ cores (for transcoding)
- **RAM**: 2 GB
- **Storage**: 50+ GB
- **Network**: 10 Mbps upload

### Per-Stream Resource Usage

- **CPU**: 0.5-2.0 cores (depends on resolution/codec)
- **RAM**: 500 MB - 2 GB (FFmpeg buffers + Node.js)
- **Network**: 3-10 Mbps (depends on bitrate settings)

---

## FFmpeg Integration

### Codec Support

**Video:**
- Input: H.264, H.265, AV1, VP9, MPEG-4
- Output: H.264 (libx264) for RTMP compatibility

**Audio:**
- Input: AAC, MP3, Opus, Vorbis, AC3
- Output: AAC for RTMP compatibility

### AV1 Decoding

- Requires libdav1d for efficient AV1 decoding
- Included in Debian FFmpeg package
- Automatically transcoded to H.264 for streaming

### Transcoding Pipeline

```
Source File → FFmpeg Decode → Scale/Pad → H.264 Encode → AAC Audio → RTMP Output
```

---

## Health Monitoring

### Built-in Healthcheck

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/ping || exit 1
```

- Checks every 30 seconds
- 10 second timeout
- 5 second startup grace period
- 3 retries before marking unhealthy

### Monitoring Endpoints

- `GET /api/ping` - Simple health check
- `GET /api/health` - Detailed status (requires auth)
- WebSocket connection for real-time updates

---

## Networking

### Port Exposure

- **3001**: HTTP/WebSocket server
- Single port for both web UI and API
- WebSocket upgrade handled automatically

### Reverse Proxy Considerations

**Required Headers:**
```
Upgrade: websocket
Connection: upgrade
X-Forwarded-For: $remote_addr
X-Forwarded-Proto: $scheme
```

**CORS Configuration:**
- Add your domain to `ALLOWED_ORIGINS`
- Comma-separated list
- Include protocol (http:// or https://)

---

## Troubleshooting

### Build Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| npm install fails | Network/registry issue | Check internet connection, try `--legacy-peer-deps` |
| FFmpeg not found | Missing package | Verify Debian base image, check apt-get logs |
| Client build fails | Node version mismatch | Ensure Node 18+ in both stages |

### Runtime Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Permission denied | UID mismatch | `chown -R 1000:1000` on media directory |
| FFmpeg codec error | Missing libdav1d | Verify FFmpeg installation includes libdav1d |
| CORS errors | Wrong ALLOWED_ORIGINS | Add your domain to environment variable |
| Stream won't start | Invalid RTMP URL | Check URL format and stream key |

---

## Maintenance

### Updating the Application

```bash
# Pull latest code
git pull

# Rebuild image
docker compose build --no-cache

# Restart with new image
docker compose up -d
```

### Updating Dependencies

```bash
# Update Node packages
npm update

# Rebuild image
docker compose build
```

### Log Management

```bash
# View logs
docker logs rtmpsquid

# Follow logs
docker logs -f rtmpsquid

# Limit log size in compose
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

---

## Performance Optimization

### Build Optimization

- Multi-stage build reduces final image size
- `.dockerignore` excludes unnecessary files
- `npm ci` for reproducible builds
- `--omit=dev` excludes development dependencies

### Runtime Optimization

- Non-root user reduces overhead
- Slim base image minimizes attack surface
- FFmpeg hardware acceleration (if available)
- Resource limits prevent runaway processes

---

## Integration Examples

### Docker Compose with Resource Limits

```yaml
services:
  rtmpsquid:
    image: rtmpsquid:latest
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '0.5'
          memory: 512M
```

### With Logging Configuration

```yaml
services:
  rtmpsquid:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### With Network Isolation

```yaml
networks:
  rtmpsquid_net:
    driver: bridge

services:
  rtmpsquid:
    networks:
      - rtmpsquid_net
```
