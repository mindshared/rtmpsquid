import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { StreamManager } from './streamManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/dist')));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB limit
});

// Initialize stream manager
const streamManager = new StreamManager(io);

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', streams: streamManager.getActiveStreams() });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  res.json({
    success: true,
    file: {
      path: req.file.path,
      filename: req.file.originalname,
      size: req.file.size
    }
  });
});

app.post('/api/stream/start', async (req, res) => {
  try {
    const { 
      filePath, 
      rtmpUrl, 
      streamKey, 
      loop, 
      bitrate, 
      audioBitrate,
      audioChannels,
      aspectRatio, 
      forceStretch, 
      resolution,
      startTime
    } = req.body;
    
    if (!filePath || !rtmpUrl) {
      return res.status(400).json({ error: 'File path and RTMP URL are required' });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fullRtmpUrl = streamKey ? `${rtmpUrl}/${streamKey}` : rtmpUrl;
    const streamId = await streamManager.startStream(filePath, fullRtmpUrl, { 
      loop, 
      bitrate,
      audioBitrate,
      audioChannels,
      aspectRatio,
      forceStretch,
      resolution,
      startTime
    });
    
    res.json({ 
      success: true, 
      streamId,
      message: 'Stream started successfully' 
    });
  } catch (error) {
    console.error('Error starting stream:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stream/stop/:streamId', async (req, res) => {
  try {
    const { streamId } = req.params;
    await streamManager.stopStream(streamId);
    
    res.json({ 
      success: true, 
      message: 'Stream stopped successfully' 
    });
  } catch (error) {
    console.error('Error stopping stream:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/streams', (req, res) => {
  res.json(streamManager.getActiveStreams());
});

app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir).map(filename => {
      const filePath = path.join(uploadsDir, filename);
      const stats = fs.statSync(filePath);
      return {
        filename,
        path: filePath,
        size: stats.size,
        created: stats.birthtime
      };
    });
    
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Browse file system directories
app.post('/api/browse-directory', (req, res) => {
  try {
    const { directory } = req.body;
    const baseDir = directory || (process.platform === 'win32' ? 'C:\\' : '/');
    
    if (!fs.existsSync(baseDir)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    const items = fs.readdirSync(baseDir, { withFileTypes: true });
    const directories = items
      .filter(item => item.isDirectory() && !item.name.startsWith('.'))
      .map(item => ({
        name: item.name,
        path: path.join(baseDir, item.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    const parent = baseDir !== '/' && baseDir !== 'C:\\' 
      ? path.dirname(baseDir) 
      : null;
    
    res.json({ 
      success: true, 
      currentPath: baseDir,
      parent,
      directories 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get common starting directories
app.get('/api/browse-home', (req, res) => {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const commonDirs = [];
    
    if (process.platform === 'darwin') {
      // macOS
      commonDirs.push(
        { name: 'Home', path: homeDir },
        { name: 'Movies', path: path.join(homeDir, 'Movies') },
        { name: 'Downloads', path: path.join(homeDir, 'Downloads') },
        { name: 'Documents', path: path.join(homeDir, 'Documents') },
        { name: 'Desktop', path: path.join(homeDir, 'Desktop') }
      );
    } else if (process.platform === 'win32') {
      // Windows
      commonDirs.push(
        { name: 'Home', path: homeDir },
        { name: 'Videos', path: path.join(homeDir, 'Videos') },
        { name: 'Downloads', path: path.join(homeDir, 'Downloads') },
        { name: 'Documents', path: path.join(homeDir, 'Documents') },
        { name: 'Desktop', path: path.join(homeDir, 'Desktop') }
      );
    } else {
      // Linux
      commonDirs.push(
        { name: 'Home', path: homeDir },
        { name: 'Videos', path: path.join(homeDir, 'Videos') },
        { name: 'Downloads', path: path.join(homeDir, 'Downloads') },
        { name: 'Documents', path: path.join(homeDir, 'Documents') },
        { name: 'Desktop', path: path.join(homeDir, 'Desktop') }
      );
    }
    
    // Filter to only existing directories
    const existing = commonDirs.filter(dir => fs.existsSync(dir.path));
    
    res.json({ success: true, directories: existing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Scan a folder for video files
app.post('/api/scan-folder', (req, res) => {
  try {
    const { folderPath, recursive, minSizeMB = 3 } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ error: 'Folder path is required' });
    }

    // Check if folder exists
    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Check if it's a directory
    const stats = fs.statSync(folderPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp'];
    const videoFiles = [];
    const minSizeBytes = minSizeMB * 1024 * 1024; // Convert MB to bytes

    const scanDirectory = (dirPath) => {
      const items = fs.readdirSync(dirPath);
      
      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const itemStats = fs.statSync(fullPath);
        
        if (itemStats.isDirectory() && recursive) {
          scanDirectory(fullPath);
        } else if (itemStats.isFile()) {
          const ext = path.extname(item).toLowerCase();
          // Filter by extension AND minimum file size
          if (videoExtensions.includes(ext) && itemStats.size >= minSizeBytes) {
            videoFiles.push({
              filename: item,
              path: fullPath,
              size: itemStats.size,
              relativePath: path.relative(folderPath, fullPath)
            });
          }
        }
      }
    };

    scanDirectory(folderPath);

    res.json({
      success: true,
      folderPath,
      count: videoFiles.length,
      files: videoFiles,
      minSizeMB
    });
  } catch (error) {
    console.error('Error scanning folder:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/files/:filename', (req, res) => {
  try {
    const filePath = path.join(uploadsDir, req.params.filename);
    
    // Security check - ensure file is in uploads directory
    if (!filePath.startsWith(uploadsDir)) {
      return res.status(403).json({ error: 'Invalid file path' });
    }
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true, message: 'File deleted' });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Playlist Routes
app.post('/api/playlists', (req, res) => {
  try {
    const { name, files, autoLoop, smartShuffle } = req.body;
    const playlistId = streamManager.createPlaylist(name || 'New Playlist', files || []);
    const playlist = streamManager.getPlaylist(playlistId);
    
    // Set auto-loop and smart shuffle if provided
    if (autoLoop !== undefined) playlist.autoLoop = autoLoop;
    if (smartShuffle !== undefined) playlist.smartShuffle = smartShuffle;
    
    res.json({ success: true, playlistId, playlist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlists', (req, res) => {
  try {
    const playlists = streamManager.getAllPlaylists();
    res.json(playlists);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlists/:playlistId', (req, res) => {
  try {
    const playlist = streamManager.getPlaylist(req.params.playlistId);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.json(playlist);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/playlists/:playlistId', (req, res) => {
  try {
    const playlist = streamManager.updatePlaylist(req.params.playlistId, req.body);
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/playlists/:playlistId', (req, res) => {
  try {
    streamManager.deletePlaylist(req.params.playlistId);
    res.json({ success: true, message: 'Playlist deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:playlistId/files', (req, res) => {
  try {
    const { filePath } = req.body;
    const playlist = streamManager.addToPlaylist(req.params.playlistId, filePath);
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/playlists/:playlistId/files/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const playlist = streamManager.removeFromPlaylist(req.params.playlistId, index);
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:playlistId/reorder', (req, res) => {
  try {
    const { fromIndex, toIndex } = req.body;
    const playlist = streamManager.reorderPlaylist(req.params.playlistId, fromIndex, toIndex);
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:playlistId/stream', async (req, res) => {
  try {
    const { 
      rtmpUrl, 
      streamKey, 
      bitrate, 
      audioBitrate,
      audioChannels,
      aspectRatio, 
      forceStretch, 
      resolution,
      startTime,
      seamless
    } = req.body;
    
    if (!rtmpUrl) {
      return res.status(400).json({ error: 'RTMP URL is required' });
    }

    const fullRtmpUrl = streamKey ? `${rtmpUrl}/${streamKey}` : rtmpUrl;
    const result = await streamManager.startPlaylist(req.params.playlistId, fullRtmpUrl, {
      bitrate,
      audioBitrate,
      audioChannels,
      aspectRatio,
      forceStretch,
      resolution,
      startTime,
      seamless
    });
    
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:playlistId/stop', (req, res) => {
  try {
    streamManager.stopPlaylist(req.params.playlistId);
    res.json({ success: true, message: 'Playlist stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:playlistId/shuffle', (req, res) => {
  try {
    const { shuffleMode, smartShuffleSize } = req.body;
    const playlist = streamManager.shufflePlaylist(
      req.params.playlistId, 
      shuffleMode || 'smart', 
      smartShuffleSize || 50
    );
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/playlists/:playlistId/watch-folder', (req, res) => {
  try {
    const { folderPath, recursive } = req.body;
    streamManager.enableFolderWatch(req.params.playlistId, folderPath, recursive);
    res.json({ success: true, message: 'Folder watching enabled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/playlists/:playlistId/watch-folder', (req, res) => {
  try {
    streamManager.disableFolderWatch(req.params.playlistId);
    res.json({ success: true, message: 'Folder watching disabled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

httpServer.listen(PORT, () => {
  console.log(`🚀 RTMP Squid server running on port ${PORT}`);
  console.log(`📁 Uploads directory: ${uploadsDir}`);
});

