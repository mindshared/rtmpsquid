import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

export class StreamManager {
  constructor(io) {
    this.io = io;
    this.activeStreams = new Map();
    this.playlists = new Map();
    this.watchedFolders = new Map();
    this.folderWatchInterval = null;
    this.startFolderWatcher();
  }

  // Normalize timestamp to HH:MM:SS format
  normalizeTimestamp(timestamp) {
    if (!timestamp) return null;
    
    timestamp = timestamp.trim();
    
    // If it's just a number (seconds)
    if (/^\d+$/.test(timestamp)) {
      const seconds = parseInt(timestamp);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    
    // If it's MM:SS format, add hours
    if (/^\d{1,2}:\d{2}$/.test(timestamp)) {
      return `00:${timestamp}`;
    }
    
    // If it's already HH:MM:SS, return as-is
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(timestamp)) {
      const parts = timestamp.split(':');
      return `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')}:${String(parts[2]).padStart(2, '0')}`;
    }
    
    // Invalid format, return null
    console.warn(`Invalid timestamp format: ${timestamp}`);
    return null;
  }

  startFolderWatcher() {
    // Check watched folders every 30 seconds
    this.folderWatchInterval = setInterval(() => {
      this.checkWatchedFolders();
    }, 30000);
  }

  async checkWatchedFolders() {
    for (const [playlistId, folderInfo] of this.watchedFolders) {
      const playlist = this.playlists.get(playlistId);
      if (!playlist) {
        this.watchedFolders.delete(playlistId);
        continue;
      }

      try {
        const currentFiles = this.scanFolderForVideos(folderInfo.path, folderInfo.recursive);
        const newFiles = currentFiles.filter(f => !playlist.files.includes(f));
        
        if (newFiles.length > 0) {
          playlist.files.push(...newFiles);
          console.log(`Added ${newFiles.length} new files to playlist ${playlist.name}`);
          this.io.emit('playlist:updated', playlist);
          this.io.emit('playlist:newfiles', {
            playlistId,
            count: newFiles.length,
            files: newFiles
          });
        }
      } catch (error) {
        console.error(`Error watching folder for playlist ${playlistId}:`, error);
      }
    }
  }

  scanFolderForVideos(folderPath, recursive = true) {
    const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp'];
    const videoFiles = [];

    const scanDirectory = (dirPath) => {
      try {
        const items = fs.readdirSync(dirPath);
        
        for (const item of items) {
          const fullPath = path.join(dirPath, item);
          const stats = fs.statSync(fullPath);
          
          if (stats.isDirectory() && recursive) {
            scanDirectory(fullPath);
          } else if (stats.isFile()) {
            const ext = path.extname(item).toLowerCase();
            if (videoExtensions.includes(ext)) {
              videoFiles.push(fullPath);
            }
          }
        }
      } catch (error) {
        console.error(`Error scanning ${dirPath}:`, error);
      }
    };

    scanDirectory(folderPath);
    return videoFiles;
  }

  async startStream(filePath, rtmpUrl, options = {}) {
    const streamId = uuidv4();
    const { 
      loop = false,
      bitrate = '3000k',
      audioBitrate = '192k',
      audioChannels = 2,
      aspectRatio = null,
      forceStretch = true,
      resolution = '1920x1080',
      playlistId = null,
      startTime = null
    } = options;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(filePath);

      // Input options
      const inputOptions = [];
      
      // Add start time if specified (before input for faster seeking)
      if (startTime) {
        const normalizedTime = this.normalizeTimestamp(startTime);
        console.log(`Start time requested: "${startTime}" -> normalized to: "${normalizedTime}"`);
        if (normalizedTime) {
          inputOptions.push('-ss', normalizedTime);
        }
      }
      
      if (loop) {
        inputOptions.push('-stream_loop', '-1');
      }
      
      inputOptions.push('-re'); // Read input at native frame rate
      
      if (inputOptions.length > 0) {
        command.inputOptions(inputOptions);
      }

      // Build video filter for aspect ratio and stretching
      const videoFilters = [];
      
      if (resolution) {
        const [width, height] = resolution.split('x');
        
        if (forceStretch) {
          // Stretch video to fill entire frame (ignore aspect ratio)
          videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=ignore,setsar=1`);
        } else {
          // Preserve aspect ratio and add black bars (letterbox/pillarbox)
          videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`);
        }
      } else if (aspectRatio) {
        // Set specific aspect ratio
        videoFilters.push(`setdar=${aspectRatio}`);
      }

      // Output options for RTMP
      const outputOptions = [
        // Video options
        '-c:v libx264',           // Video codec
        '-preset veryfast',       // Encoding preset
        `-b:v ${bitrate}`,        // Video bitrate
        `-maxrate ${bitrate}`,    // Max bitrate
        `-bufsize ${parseInt(bitrate) * 2}k`, // Buffer size
        '-pix_fmt yuv420p',       // Pixel format
        '-g 50',                  // GOP size
        '-keyint_min 50',         // Minimum keyframe interval
        
        // Audio options
        '-c:a aac',               // Audio codec
        `-b:a ${audioBitrate}`,   // Audio bitrate
        '-ar 44100',              // Audio sample rate
        `-ac ${audioChannels}`,   // Audio channels (1=mono, 2=stereo)
        '-strict -2',             // Allow experimental AAC encoder
        
        // Container options
        '-f flv'                  // Format for RTMP
      ];

      command.outputOptions(outputOptions);

      if (videoFilters.length > 0) {
        command.videoFilters(videoFilters);
      }

      command.output(rtmpUrl);

      // Event handlers
      command.on('start', (commandLine) => {
        console.log(`Stream ${streamId} started:`, commandLine);
        
        this.activeStreams.set(streamId, {
          id: streamId,
          filePath,
          rtmpUrl,
          command,
          startTime: Date.now(),
          status: 'streaming',
          playlistId,
          options
        });

        this.io.emit('stream:started', {
          streamId,
          filePath: path.basename(filePath),
          rtmpUrl
        });

        resolve(streamId);
      });

      command.on('progress', (progress) => {
        this.io.emit('stream:progress', {
          streamId,
          ...progress
        });
      });

      command.on('error', (err, stdout, stderr) => {
        console.error(`Stream ${streamId} error:`, err.message);
        console.error('FFmpeg stderr:', stderr);
        
        this.activeStreams.delete(streamId);
        
        this.io.emit('stream:error', {
          streamId,
          error: err.message
        });
      });

      command.on('end', () => {
        console.log(`Stream ${streamId} ended`);
        
        const stream = this.activeStreams.get(streamId);
        this.activeStreams.delete(streamId);
        
        this.io.emit('stream:ended', {
          streamId
        });

        // If part of a playlist, start next file
        if (stream && stream.playlistId) {
          this.advancePlaylist(stream.playlistId);
        }
      });

      try {
        command.run();
      } catch (error) {
        reject(error);
      }
    });
  }

  async stopStream(streamId) {
    const stream = this.activeStreams.get(streamId);
    
    if (!stream) {
      throw new Error('Stream not found');
    }

    return new Promise((resolve) => {
      stream.command.on('end', () => {
        this.activeStreams.delete(streamId);
        resolve();
      });

      stream.command.kill('SIGTERM');
      
      // Force kill after 5 seconds if not stopped
      setTimeout(() => {
        if (this.activeStreams.has(streamId)) {
          stream.command.kill('SIGKILL');
          this.activeStreams.delete(streamId);
          resolve();
        }
      }, 5000);
    });
  }

  getActiveStreams() {
    return Array.from(this.activeStreams.values()).map(stream => ({
      id: stream.id,
      filePath: path.basename(stream.filePath),
      rtmpUrl: stream.rtmpUrl,
      startTime: stream.startTime,
      status: stream.status
    }));
  }

  stopAllStreams() {
    const promises = [];
    for (const streamId of this.activeStreams.keys()) {
      promises.push(this.stopStream(streamId));
    }
    return Promise.all(promises);
  }

  // Playlist management
  createPlaylist(name, files = []) {
    const playlistId = uuidv4();
    this.playlists.set(playlistId, {
      id: playlistId,
      name,
      files,
      currentIndex: 0,
      created: Date.now(),
      recentlyPlayed: [],
      shuffleMode: 'smart', // 'none', 'random', or 'smart'
      smartShuffleSize: 50   // How many movies to avoid repeating
    });
    return playlistId;
  }

  getPlaylist(playlistId) {
    return this.playlists.get(playlistId);
  }

  getAllPlaylists() {
    return Array.from(this.playlists.values());
  }

  updatePlaylist(playlistId, updates) {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    Object.assign(playlist, updates);
    this.io.emit('playlist:updated', playlist);
    return playlist;
  }

  enableFolderWatch(playlistId, folderPath, recursive = true) {
    this.watchedFolders.set(playlistId, {
      path: folderPath,
      recursive,
      lastCheck: Date.now()
    });
    return true;
  }

  disableFolderWatch(playlistId) {
    this.watchedFolders.delete(playlistId);
    return true;
  }

  shufflePlaylist(playlistId, smartShuffle = true) {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      throw new Error('Playlist not found');
    }

    if (smartShuffle && playlist.files.length > 10) {
      // Smart shuffle: avoid recently played files
      const recentlyPlayed = playlist.recentlyPlayed || [];
      const availableFiles = playlist.files.filter(file => !recentlyPlayed.includes(file));
      
      if (availableFiles.length === 0) {
        // All files recently played, clear history except last one
        playlist.recentlyPlayed = recentlyPlayed.slice(-1);
        return this.shufflePlaylist(playlistId, smartShuffle);
      }

      // Fisher-Yates shuffle of available files
      const shuffled = [...availableFiles];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      // Place recently played at the end
      playlist.files = [...shuffled, ...recentlyPlayed];
      playlist.currentIndex = 0;
    } else {
      // Standard Fisher-Yates shuffle
      const files = [...playlist.files];
      for (let i = files.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [files[i], files[j]] = [files[j], files[i]];
      }
      playlist.files = files;
      playlist.currentIndex = 0;
    }

    this.io.emit('playlist:updated', playlist);
    return playlist;
  }

  // Smart shuffle helper - avoids recently played files
  shuffleArray(fileList, recentlyPlayed = [], historySize = 50) {
    const recentlyPlayedSet = new Set(recentlyPlayed.slice(-historySize));
    const availableFiles = fileList.filter(file => !recentlyPlayedSet.has(file));
    
    if (availableFiles.length === 0) {
      // All files recently played, just do random shuffle
      const shuffled = [...fileList];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }

    // Fisher-Yates shuffle of available files
    const shuffled = [...availableFiles];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
  }

  deletePlaylist(playlistId) {
    this.playlists.delete(playlistId);
  }

  addToPlaylist(playlistId, filePath) {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    playlist.files.push(filePath);
    this.io.emit('playlist:updated', playlist);
    return playlist;
  }

  removeFromPlaylist(playlistId, index) {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    playlist.files.splice(index, 1);
    if (playlist.currentIndex >= playlist.files.length) {
      playlist.currentIndex = Math.max(0, playlist.files.length - 1);
    }
    this.io.emit('playlist:updated', playlist);
    return playlist;
  }

  reorderPlaylist(playlistId, fromIndex, toIndex) {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    const [removed] = playlist.files.splice(fromIndex, 1);
    playlist.files.splice(toIndex, 0, removed);
    this.io.emit('playlist:updated', playlist);
    return playlist;
  }

  async startPlaylist(playlistId, rtmpUrl, streamOptions = {}) {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    if (playlist.files.length === 0) {
      throw new Error('Playlist is empty');
    }

    // Check if seamless mode is enabled
    const seamless = streamOptions.seamless !== undefined ? streamOptions.seamless : false;

    if (seamless) {
      // Use FFmpeg concat demuxer for seamless playback
      return this.startSeamlessPlaylist(playlistId, rtmpUrl, streamOptions);
    }

    // Traditional method: stream files one by one
    playlist.currentIndex = 0;
    playlist.streaming = true;
    playlist.rtmpUrl = rtmpUrl;
    playlist.streamOptions = streamOptions;

    const filePath = playlist.files[0];
    const streamId = await this.startStream(filePath, rtmpUrl, {
      ...streamOptions,
      playlistId,
      loop: false,
      seamless: undefined // Don't pass seamless to individual file streams
    });

    return { playlistId, streamId };
  }

  async startSeamlessPlaylist(playlistId, rtmpUrl, streamOptions = {}) {
    const playlist = this.playlists.get(playlistId);
    const streamId = uuidv4();
    
    // Create a temporary concat file
    const os = await import('os');
    const concatFilePath = path.join(os.tmpdir(), `rtmpsquid-${streamId}.txt`);
    
    // Get file list and apply shuffle based on mode
    let fileList = [...playlist.files];
    
    if (playlist.shuffleMode === 'smart') {
      // Smart shuffle - avoid recently played
      fileList = this.shuffleArray(fileList, playlist.recentlyPlayed || [], playlist.smartShuffleSize || 50);
    } else if (playlist.shuffleMode === 'random') {
      // Random shuffle - pure randomization
      for (let i = fileList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [fileList[i], fileList[j]] = [fileList[j], fileList[i]];
      }
    }
    // else: 'none' - play in original order
    
    // Create concat file content
    // FFmpeg concat demuxer format: file '/path/to/file.mp4'
    const concatContent = fileList
      .map(filePath => `file '${filePath.replace(/'/g, "'\\''")}'`) // Escape single quotes for shell
      .join('\n');
    
    fs.writeFileSync(concatFilePath, concatContent);
    console.log(`🔗 Seamless playlist "${playlist.name}" created with ${fileList.length} files`);
    console.log(`Concat file: ${concatFilePath}`);

    const { 
      bitrate = '3000k',
      audioBitrate = '192k',
      audioChannels = 2,
      aspectRatio = null,
      forceStretch = true,
      resolution = '1920x1080',
      startTime = null
    } = streamOptions;

    return new Promise((resolve, reject) => {
      const command = ffmpeg();
      
      // Input options for concat demuxer
      const inputOptions = ['-f', 'concat', '-safe', '0'];
      
      // Add start time if specified
      if (startTime) {
        const normalizedTime = this.normalizeTimestamp(startTime);
        console.log(`Start time requested: "${startTime}" -> normalized to: "${normalizedTime}"`);
        if (normalizedTime) {
          inputOptions.push('-ss', normalizedTime);
        }
      }
      
      inputOptions.push('-re'); // Read at native frame rate
      
      command
        .input(concatFilePath)
        .inputOptions(inputOptions);

      // Build video filter
      const videoFilters = [];
      if (resolution) {
        const [width, height] = resolution.split('x');
        
        if (forceStretch) {
          // Stretch video to fill entire frame (ignore aspect ratio)
          videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=ignore,setsar=1`);
        } else {
          // Preserve aspect ratio and add black bars
          videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`);
        }
      } else if (aspectRatio) {
        videoFilters.push(`setdar=${aspectRatio}`);
      }

      // Output options
      const outputOptions = [
        '-c:v libx264',
        '-preset veryfast',
        `-b:v ${bitrate}`,
        `-maxrate ${bitrate}`,
        `-bufsize ${parseInt(bitrate) * 2}k`,
        '-pix_fmt yuv420p',
        '-g 50',
        '-keyint_min 50',
        '-c:a aac',
        `-b:a ${audioBitrate}`,
        '-ar 44100',
        `-ac ${audioChannels}`,
        '-strict -2',
        '-f flv'
      ];

      command.outputOptions(outputOptions);

      if (videoFilters.length > 0) {
        command.videoFilters(videoFilters);
      }

      command.output(rtmpUrl);

      // Event handlers
      command.on('start', (commandLine) => {
        console.log(`🎬 Seamless playlist stream ${streamId} started for "${playlist.name}"`);
        console.log('FFmpeg command:', commandLine);
        
        this.activeStreams.set(streamId, {
          id: streamId,
          filePath: `🔗 Playlist: ${playlist.name} (${fileList.length} files)`,
          rtmpUrl,
          command,
          startTime: Date.now(),
          status: 'streaming',
          playlistId,
          seamless: true,
          concatFile: concatFilePath
        });

        playlist.streaming = true;
        playlist.streamId = streamId;

        this.io.emit('playlist:started', {
          playlistId,
          streamId,
          playlist: playlist.name,
          totalFiles: fileList.length,
          seamless: true
        });

        resolve({ playlistId, streamId, seamless: true });
      });

      command.on('progress', (progress) => {
        this.io.emit('stream:progress', {
          streamId,
          playlistId,
          ...progress
        });
      });

      command.on('error', (err, stdout, stderr) => {
        console.error(`❌ Seamless playlist ${streamId} error:`, err.message);
        console.error('FFmpeg stderr:', stderr);
        
        // Clean up concat file
        try {
          fs.unlinkSync(concatFilePath);
          console.log(`🗑️ Cleaned up concat file: ${concatFilePath}`);
        } catch (e) {
          console.error('Error deleting concat file:', e);
        }
        
        this.activeStreams.delete(streamId);
        playlist.streaming = false;
        
        this.io.emit('stream:error', {
          streamId,
          playlistId,
          error: err.message
        });
      });

      command.on('end', () => {
        console.log(`✅ Seamless playlist ${streamId} completed all ${fileList.length} files`);
        
        // Clean up concat file
        try {
          fs.unlinkSync(concatFilePath);
          console.log(`🗑️ Cleaned up concat file: ${concatFilePath}`);
        } catch (e) {
          console.error('Error deleting concat file:', e);
        }
        
        this.activeStreams.delete(streamId);
        playlist.streaming = false;
        
        this.io.emit('playlist:completed', {
          playlistId,
          streamId
        });
      });

      try {
        command.run();
      } catch (error) {
        // Clean up concat file on error
        try {
          fs.unlinkSync(concatFilePath);
        } catch (e) {
          console.error('Error deleting concat file:', e);
        }
        reject(error);
      }
    });
  }

  async advancePlaylist(playlistId) {
    const playlist = this.playlists.get(playlistId);
    if (!playlist || !playlist.streaming) {
      return;
    }

    // Track recently played
    const currentFile = playlist.files[playlist.currentIndex];
    if (!playlist.recentlyPlayed) {
      playlist.recentlyPlayed = [];
    }
    
    // Add to recently played and keep only last N (based on smartShuffleSize)
    const historySize = playlist.smartShuffleSize || 50;
    if (!playlist.recentlyPlayed.includes(currentFile)) {
      playlist.recentlyPlayed.push(currentFile);
      if (playlist.recentlyPlayed.length > historySize) {
        playlist.recentlyPlayed.shift(); // Remove oldest
      }
    }

    playlist.currentIndex++;

    if (playlist.currentIndex >= playlist.files.length) {
      // End of playlist - auto-shuffle and restart if enabled
      if (playlist.autoLoop) {
        console.log(`Playlist ${playlist.name} completed, shuffling and restarting...`);
        this.shufflePlaylist(playlistId, playlist.smartShuffle);
        playlist.streaming = true;
        playlist.currentIndex = 0;
        
        const filePath = playlist.files[0];
        this.io.emit('playlist:shuffled', { playlistId });
        
        try {
          await this.startStream(filePath, playlist.rtmpUrl, {
            ...playlist.streamOptions,
            playlistId,
            loop: false
          });
        } catch (error) {
          console.error('Error restarting playlist:', error);
          playlist.streaming = false;
        }
      } else {
        // End of playlist
        playlist.streaming = false;
        playlist.currentIndex = 0;
        this.io.emit('playlist:completed', { playlistId });
      }
      return;
    }

    // Start next file
    const filePath = playlist.files[playlist.currentIndex];
    this.io.emit('playlist:next', { 
      playlistId, 
      index: playlist.currentIndex,
      filePath: path.basename(filePath)
    });

    try {
      await this.startStream(filePath, playlist.rtmpUrl, {
        ...playlist.streamOptions,
        playlistId,
        loop: false
      });
    } catch (error) {
      console.error('Error advancing playlist:', error);
      playlist.streaming = false;
    }
  }

  stopPlaylist(playlistId) {
    const playlist = this.playlists.get(playlistId);
    if (playlist) {
      playlist.streaming = false;
      
      // Stop any active streams for this playlist
      for (const [streamId, stream] of this.activeStreams) {
        if (stream.playlistId === playlistId) {
          this.stopStream(streamId);
        }
      }
    }
  }
}

