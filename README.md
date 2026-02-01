# RTMP Squid

Web application for streaming video playlists to RTMP servers (Twitch, YouTube, AngelThump, etc).

## Features

- Scan folders for video files and create playlists
- Smart shuffle (avoids repeating recently played videos)
- Auto-loop playlists for 24/7 streaming
- Drag-and-drop playlist reordering
- Folder watching (auto-adds new files)
- Configurable video/audio bitrate and resolution
- Video fit modes (preserve aspect ratio or stretch to fill)
- Real-time stream status monitoring
- Filter small files (< 5MB)

## Requirements

- Node.js 18 or higher
- FFmpeg 4.0 or higher

## Installation

```bash
npm install
cd client && npm install
```

## Usage

Start the server and client:

```bash
npm run dev
```

This starts:
- Backend server on http://localhost:3001
- Frontend on http://localhost:5173

Open http://localhost:5173 in your browser.

## Quick Start

1. Enter a folder path containing video files or click Browse
2. Configure shuffle mode and file filters
3. Click "Create Playlist"
4. Enter your RTMP URL and stream key
5. Adjust video/audio settings if needed
6. Click "START STREAM"

## Configuration

### Video Settings
- **Resolution**: 720p, 1080p, 1440p
- **Video Bitrate**: 2000k to 6000k
- **Audio Bitrate**: 128k to 320k
- **Video Fit**: Fit (adds black bars) or Stretch (fills screen)

### Playlist Settings
- **Shuffle Mode**: Sequential, Random, or Smart (no repeats for N movies)
- **Auto-loop**: Restart playlist when finished
- **Watch folder**: Automatically add new files
- **Filter small files**: Ignore files under 5MB

## Supported Formats

`.mp4`, `.mkv`, `.avi`, `.mov`, `.flv`, `.wmv`, `.webm`, `.m4v`, `.mpg`, `.mpeg`, `.3gp`

## RTMP Services

Default RTMP URL: `rtmp://ingest.angelthump.com/live`

Works with:
- AngelThump
- Twitch (`rtmp://live.twitch.tv/app`)
- YouTube (`rtmp://a.rtmp.youtube.com/live2`)
- Any custom RTMP server

## Development

Start in development mode:

```bash
npm run dev
```

Server code: `server/`
Client code: `client/src/`

## Platform Support

- macOS
- Linux (Ubuntu, Debian)
- Windows

## Troubleshooting

### FFmpeg not found
Install FFmpeg and ensure it's in your PATH:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
Download from https://ffmpeg.org/download.html
```

### Port already in use
Kill processes on ports 3001 or 5173, or change ports in:
- Server: `server/index.js`
- Client: `client/vite.config.js`

### Stream not starting
- Verify RTMP URL and stream key
- Check FFmpeg installation
- Ensure video files are readable
- Check server logs for errors

## License

MIT
