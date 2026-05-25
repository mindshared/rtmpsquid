# RTMP Squid Docker Deployment Guide

Quick guide for deploying RTMP Squid using Docker and Docker Compose.

---

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Clone the repository
git clone https://github.com/mindshared/rtmpsquid.git
cd rtmpsquid

# Create media directory
mkdir -p data/media

# Generate secure AUTH_TOKEN
AUTH_TOKEN=$(openssl rand -hex 16)

# Create .env file
cat > .env <<EOF
AUTH_TOKEN=${AUTH_TOKEN}
HOST=0.0.0.0
PORT=3001
MEDIA_ROOT=/media
LIBRARY_DIR=/media/library
ALLOWED_ORIGINS=http://localhost:3001
SCAN_MAX_DEPTH=12
QUEUE_MIN=5
QUEUE_TARGET=20
MIN_MOVIE_MB=5
EOF

# Set secure permissions
chmod 600 .env

# Build and start
docker compose up -d

# View your AUTH_TOKEN
echo "Your AUTH_TOKEN: ${AUTH_TOKEN}"
```

### Using Docker CLI

```bash
# Build the image
docker build -t rtmpsquid:latest .

# Run the container
docker run -d \
  --name rtmpsquid \
  -p 3001:3001 \
  -v $(pwd)/data/media:/media \
  -v $(pwd)/.env:/app/.env:ro \
  --restart unless-stopped \
  rtmpsquid:latest
```

---

## Configuration

### Environment Variables

Create a `.env` file with these variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | (required) | Authentication token for dashboard access |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `3001` | Server port |
| `MEDIA_ROOT` | `/media` | Root directory for media files |
| `LIBRARY_DIR` | `/media/library` | Directory to scan for movies |
| `ALLOWED_ORIGINS` | `http://localhost:3001` | CORS allowed origins (comma-separated) |
| `SCAN_MAX_DEPTH` | `12` | Maximum directory depth to scan |
| `QUEUE_MIN` | `5` | Minimum queue size before auto-fill |
| `QUEUE_TARGET` | `20` | Target queue size for auto-fill |
| `MIN_MOVIE_MB` | `5` | Minimum file size (MB) to include |

### Generating AUTH_TOKEN

Use a secure random generator:

```bash
# Using openssl (recommended)
openssl rand -hex 16

# Using /dev/urandom
head -c 16 /dev/urandom | xxd -p

# Using Node.js
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

---

## Post-Deployment

### 1. Access the Dashboard

Open your browser to `http://localhost:3001` (or your server's IP/domain)

### 2. Login

Enter the `AUTH_TOKEN` from your `.env` file

### 3. Add Media Files

Copy your video files to the media directory:

```bash
# Local files
cp -r /path/to/movies/* ./data/media/

# Or organize into subdirectories
mkdir -p ./data/media/movies
cp -r /path/to/movies/* ./data/media/movies/
```

### 4. Configure Library

In the dashboard:
1. Go to **Settings** → **Movie library**
2. Click **Browse** and select `/media` (or a subdirectory)
3. Set minimum file size if desired
4. Click **Use this folder**

### 5. Configure Streaming

In **Settings** → **Destination**:
1. Enter your RTMP URL (e.g., `rtmp://live.twitch.tv/app`)
2. Enter your stream key
3. Adjust quality settings as needed

### 6. Go Live

Click **● Go Live** to start streaming!

---

## Management

### View Logs

```bash
docker logs -f rtmpsquid
```

### Restart Container

```bash
docker compose restart
# or
docker restart rtmpsquid
```

### Stop Container

```bash
docker compose down
# or
docker stop rtmpsquid
```

### Rebuild After Updates

```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose build --no-cache
docker compose up -d
```

---

## Reverse Proxy Setup

### Nginx

```nginx
server {
    listen 80;
    server_name rtmpsquid.example.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Traefik (Docker Labels)

Add these labels to your `docker-compose.yaml`:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.rtmpsquid.rule=Host(`rtmpsquid.example.com`)"
  - "traefik.http.routers.rtmpsquid.entrypoints=websecure"
  - "traefik.http.routers.rtmpsquid.tls.certresolver=letsencrypt"
  - "traefik.http.services.rtmpsquid.loadbalancer.server.port=3001"
```

Don't forget to update `ALLOWED_ORIGINS` in your `.env`:

```bash
ALLOWED_ORIGINS=https://rtmpsquid.example.com,http://localhost:3001
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Container won't start | Check logs: `docker logs rtmpsquid` |
| AUTH_TOKEN rejected | Verify token matches `.env` file exactly |
| No media files visible | Ensure files are in `/media` mount and readable |
| Permission errors | Check file ownership: `chown -R 1000:1000 ./data/media` |
| Port already in use | Change port in `.env` and `docker-compose.yaml` |
| CORS errors | Add your domain to `ALLOWED_ORIGINS` |
| Stream won't start | Verify FFmpeg is installed: `docker exec rtmpsquid ffmpeg -version` |

---

## Security Best Practices

1. **Strong AUTH_TOKEN**: Use at least 16 bytes of random data
2. **Secure .env**: Set permissions to `600` (owner read/write only)
3. **Non-root user**: Container runs as UID/GID 1000 (node user)
4. **HTTPS**: Use a reverse proxy with TLS for production
5. **Firewall**: Only expose port 3001 to trusted networks
6. **Regular updates**: Keep Docker image and dependencies updated
