# Multi-stage Docker build for RTMP Squid
# Stage 1: Build React/Vite client
FROM node:18-alpine AS client-builder

WORKDIR /app/client

# Copy client package files and install dependencies
COPY client/package*.json ./
RUN npm install

# Copy client source and build
COPY client/ ./
RUN npm run build

# Stage 2: Runtime image with FFmpeg
FROM node:18-slim

# Install FFmpeg with dependencies + curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy server code
COPY server/ ./server/

# Copy built client from Stage 1
COPY --from=client-builder /app/client/dist ./client/dist

# Use the non-root user already provided by the official Node image.
# node:18-slim ships with uid/gid 1000, so creating another 1000:1000
# user/group fails on rebuilds with "GID '1000' already exists".
USER node

# Environment defaults
ENV HOST=0.0.0.0 \
    PORT=3001 \
    MEDIA_ROOT=/media \
    LIBRARY_DIR=/media/library \
    ALLOWED_ORIGINS=http://localhost:3001

# Expose application port
EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/ping || exit 1

# Start the application
CMD ["node", "server/index.js"]
