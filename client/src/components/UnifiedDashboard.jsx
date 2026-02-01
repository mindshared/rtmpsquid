import { useState, useEffect } from 'react';
import axios from 'axios';
import FolderBrowser from './FolderBrowser';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function UnifiedDashboard({ socket, onStartStream, onStopStream, activeStreams }) {
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [folderPath, setFolderPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [showAddFileDialog, setShowAddFileDialog] = useState(false);
  
  // Settings
  const [scanRecursive, setScanRecursive] = useState(true);
  const [filterSmallFiles, setFilterSmallFiles] = useState(true);
  const [shuffleMode, setShuffleMode] = useState('smart');
  const [noRepeatCount, setNoRepeatCount] = useState(50);
  const [autoLoop, setAutoLoop] = useState(true);
  const [watchFolder, setWatchFolder] = useState(false);
  
  // Stream settings
  const [rtmpUrl, setRtmpUrl] = useState('rtmp://ingest.angelthump.com/live');
  const [streamKey, setStreamKey] = useState('');
  const [bitrate, setBitrate] = useState('3000k');
  const [resolution, setResolution] = useState('1920x1080');
  const [videoFit, setVideoFit] = useState('fit');
  const [audioBitrate, setAudioBitrate] = useState('192k');
  
  const [draggedIndex, setDraggedIndex] = useState(null);

  useEffect(() => {
    fetchPlaylists();
  }, []);

  useEffect(() => {
    if (!socket) return;

    socket.on('playlist:updated', (playlist) => {
      setPlaylists(prev => 
        prev.map(p => p.id === playlist.id ? playlist : p)
      );
      if (selectedPlaylist?.id === playlist.id) {
        setSelectedPlaylist(playlist);
      }
    });

    return () => {
      socket.off('playlist:updated');
    };
  }, [socket, selectedPlaylist]);

  const fetchPlaylists = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/playlists`);
      setPlaylists(response.data);
    } catch (error) {
      console.error('Error fetching playlists:', error);
    }
  };

  const scanAndCreatePlaylist = async () => {
    if (!folderPath.trim()) {
      alert('Please enter a folder path');
      return;
    }

    setScanning(true);
    try {
      const response = await axios.post(`${API_URL}/api/scan-folder`, {
        folderPath: folderPath.trim(),
        recursive: scanRecursive,
        minSizeMB: filterSmallFiles ? 5 : 0
      });

      if (response.data.files.length === 0) {
        const filterMsg = filterSmallFiles ? ' (>= 5MB)' : '';
        alert(`No video files found${filterMsg}\n\nPath: ${folderPath}`);
        setScanning(false);
        return;
      }

      const folderName = folderPath.split('/').pop() || folderPath.split('\\').pop() || 'Playlist';
      const createResponse = await axios.post(`${API_URL}/api/playlists`, {
        name: folderName,
        files: response.data.files.map(f => f.path),
        autoLoop,
        smartShuffle: shuffleMode === 'smart',
        shuffleMode,
        smartShuffleSize: noRepeatCount
      });

      const newPlaylist = createResponse.data.playlist;
      
      if (shuffleMode !== 'none') {
        await axios.post(`${API_URL}/api/playlists/${newPlaylist.id}/shuffle`, {
          shuffleMode,
          smartShuffleSize: noRepeatCount
        });
      }
      
      if (watchFolder) {
        await axios.post(`${API_URL}/api/playlists/${newPlaylist.id}/watch-folder`, {
          folderPath: folderPath.trim(),
          recursive: scanRecursive
        });
      }
      
      setPlaylists([...playlists, newPlaylist]);
      setSelectedPlaylist(newPlaylist);
      setFolderPath('');
      
      const filterMsg = filterSmallFiles ? ' (>= 5MB)' : '';
      alert(`Created "${folderName}" with ${response.data.count} videos${filterMsg}`);
    } catch (error) {
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setScanning(false);
    }
  };

  const deletePlaylist = async (playlistId) => {
    try {
      await axios.delete(`${API_URL}/api/playlists/${playlistId}`);
      setPlaylists(playlists.filter(p => p.id !== playlistId));
      if (selectedPlaylist?.id === playlistId) {
        setSelectedPlaylist(null);
      }
    } catch (error) {
      console.error('Error deleting playlist:', error);
    }
  };

  const moveFileInPlaylist = async (fromIndex, toIndex) => {
    if (!selectedPlaylist) return;
    
    try {
      const response = await axios.post(
        `${API_URL}/api/playlists/${selectedPlaylist.id}/reorder`,
        { fromIndex, toIndex }
      );
      setSelectedPlaylist(response.data.playlist);
      setPlaylists(prev => 
        prev.map(p => p.id === selectedPlaylist.id ? response.data.playlist : p)
      );
    } catch (error) {
      console.error('Error moving file:', error);
    }
  };

  const removeFileFromPlaylist = async (index) => {
    if (!selectedPlaylist) return;
    
    try {
      const response = await axios.delete(
        `${API_URL}/api/playlists/${selectedPlaylist.id}/files/${index}`
      );
      setSelectedPlaylist(response.data.playlist);
    } catch (error) {
      console.error('Error removing file:', error);
    }
  };

  const shufflePlaylist = async (mode) => {
    if (!selectedPlaylist) return;
    
    try {
      const response = await axios.post(
        `${API_URL}/api/playlists/${selectedPlaylist.id}/shuffle`,
        {
          shuffleMode: mode || shuffleMode,
          smartShuffleSize: noRepeatCount
        }
      );
      setSelectedPlaylist(response.data.playlist);
      setPlaylists(prev => 
        prev.map(p => p.id === selectedPlaylist.id ? response.data.playlist : p)
      );
    } catch (error) {
      console.error('Error shuffling playlist:', error);
    }
  };

  const moveToTop = async (index) => {
    if (!selectedPlaylist || index === 0) return;
    await moveFileInPlaylist(index, 0);
  };

  const addFilesToPlaylist = async (e) => {
    if (!selectedPlaylist) {
      alert('Please select a playlist first');
      return;
    }

    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    try {
      for (const file of files) {
        // Create a temporary upload or use file path if available
        const filePath = file.path || file.webkitRelativePath || file.name;
        
        await axios.post(
          `${API_URL}/api/playlists/${selectedPlaylist.id}/files`,
          { filePath: filePath }
        );
      }
      
      // Refresh playlist
      const response = await axios.get(`${API_URL}/api/playlists`);
      const updatedPlaylist = response.data.find(p => p.id === selectedPlaylist.id);
      if (updatedPlaylist) {
        setSelectedPlaylist(updatedPlaylist);
        setPlaylists(response.data);
      }
      
      alert(`Added ${files.length} file(s) to playlist`);
    } catch (error) {
      alert(`Error adding files: ${error.response?.data?.error || error.message}`);
    }
    
    setShowAddFileDialog(false);
  };

  const handleStartStream = async () => {
    if (!selectedPlaylist) {
      alert('Please create/select a playlist first');
      return;
    }
    if (!streamKey.trim()) {
      alert('Please enter your stream key');
      return;
    }

    await onStartStream(rtmpUrl, streamKey, autoLoop, {
      bitrate,
      resolution,
      audioBitrate,
      audioChannels: 2,
      forceStretch: videoFit === 'stretch',
      seamless: true
    }, selectedPlaylist);
  };

  const currentStream = activeStreams[0]; // Assuming one active stream

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '2rem', height: 'calc(100vh - 200px)' }}>
      
      {/* Left Sidebar - Configuration */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto', paddingRight: '0.5rem' }}>
        
        {/* Folder Scanner */}
        <div className="card" style={{ padding: '1rem' }}>
          <h3 style={{ color: '#00ff00', fontSize: '0.9rem', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
            Scan Folder
          </h3>
          
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <input
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="Folder path..."
              style={{ flex: 1, padding: '0.5rem', fontSize: '0.85rem' }}
            />
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setShowFolderBrowser(true)}
              style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem' }}
            >
              Browse
            </button>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem', fontSize: '0.8rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#aaa' }}>
              <input
                type="checkbox"
                checked={scanRecursive}
                onChange={(e) => setScanRecursive(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Include subfolders
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#aaa' }}>
              <input
                type="checkbox"
                checked={watchFolder}
                onChange={(e) => setWatchFolder(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Watch for new files
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#aaa' }}>
              <input
                type="checkbox"
                checked={filterSmallFiles}
                onChange={(e) => setFilterSmallFiles(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Ignore files {'<'} 5MB
            </label>
          </div>
          
          <button
            className="btn btn-primary"
            onClick={scanAndCreatePlaylist}
            disabled={scanning || !folderPath.trim()}
            style={{ width: '100%', padding: '0.5rem', fontSize: '0.85rem' }}
          >
            {scanning ? 'Scanning...' : 'Create Playlist'}
          </button>
        </div>

        {/* Playlist Shuffle Settings */}
        <div className="card" style={{ padding: '1rem' }}>
          <h3 style={{ color: '#00ff00', fontSize: '0.9rem', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
            Shuffle Mode
          </h3>
          
          <select
            value={shuffleMode}
            onChange={(e) => setShuffleMode(e.target.value)}
            style={{ width: '100%', marginBottom: '0.75rem', padding: '0.5rem', fontSize: '0.85rem' }}
          >
            <option value="none">Sequential (no shuffle)</option>
            <option value="random">Random shuffle</option>
            <option value="smart">Smart shuffle (no repeats)</option>
          </select>
          
          {shuffleMode === 'smart' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#aaa', marginBottom: '0.75rem' }}>
              No repeats for:
              <input
                type="number"
                min="1"
                max="500"
                value={noRepeatCount}
                onChange={(e) => setNoRepeatCount(parseInt(e.target.value) || 50)}
                style={{ width: '60px', padding: '0.25rem', fontSize: '0.8rem' }}
              />
              movies
            </label>
          )}
          
          {selectedPlaylist && (
            <button
              className="btn btn-primary"
              onClick={() => shufflePlaylist()}
              style={{ width: '100%', padding: '0.5rem', fontSize: '0.85rem' }}
            >
              Apply Shuffle Now
            </button>
          )}
          
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#aaa', marginTop: '0.75rem' }}>
            <input
              type="checkbox"
              checked={autoLoop}
              onChange={(e) => setAutoLoop(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Auto-loop playlist
          </label>
        </div>

        {/* Stream Configuration */}
        <div className="card" style={{ padding: '1rem' }}>
          <h3 style={{ color: '#00ff00', fontSize: '0.9rem', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
            Stream Settings
          </h3>
          
          <input
            type="text"
            value={rtmpUrl}
            onChange={(e) => setRtmpUrl(e.target.value)}
            placeholder="RTMP URL"
            style={{ width: '100%', marginBottom: '0.5rem', padding: '0.5rem', fontSize: '0.85rem' }}
          />
          
          <input
            type="password"
            value={streamKey}
            onChange={(e) => setStreamKey(e.target.value)}
            placeholder="Stream Key"
            style={{ width: '100%', marginBottom: '0.75rem', padding: '0.5rem', fontSize: '0.85rem' }}
          />
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '0.25rem' }}>Resolution</label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem' }}
              >
                <option value="1280x720">720p</option>
                <option value="1920x1080">1080p</option>
                <option value="2560x1440">1440p</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '0.25rem' }}>Video Fit</label>
              <select
                value={videoFit}
                onChange={(e) => setVideoFit(e.target.value)}
                style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem' }}
              >
                <option value="fit">Fit</option>
                <option value="stretch">Stretch</option>
              </select>
            </div>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '0.25rem' }}>Video Bitrate</label>
              <select
                value={bitrate}
                onChange={(e) => setBitrate(e.target.value)}
                style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem' }}
              >
                <option value="2000k">2000k</option>
                <option value="3000k">3000k</option>
                <option value="4000k">4000k</option>
                <option value="5000k">5000k</option>
                <option value="6000k">6000k</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '0.25rem' }}>Audio Bitrate</label>
              <select
                value={audioBitrate}
                onChange={(e) => setAudioBitrate(e.target.value)}
                style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem' }}
              >
                <option value="128k">128k</option>
                <option value="192k">192k</option>
                <option value="256k">256k</option>
                <option value="320k">320k</option>
              </select>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className="btn btn-primary"
            onClick={handleStartStream}
            disabled={!selectedPlaylist || !streamKey.trim() || currentStream}
            style={{ flex: 1, padding: '0.75rem', fontSize: '0.9rem', fontWeight: 'bold' }}
          >
            {currentStream ? 'STREAMING' : 'START STREAM'}
          </button>
          {currentStream && (
            <button
              className="btn btn-danger"
              onClick={() => onStopStream(currentStream.id)}
              style={{ padding: '0.75rem 1rem', fontSize: '0.9rem' }}
            >
              STOP
            </button>
          )}
        </div>
      </div>

      {/* Right Main Area - Stream Status & Playlist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto' }}>
        
        {/* Live Stream Status */}
        {currentStream && (
          <div className="card" style={{ background: '#001a00', border: '2px solid #00ff00', padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div>
                <h2 style={{ color: '#00ff00', fontSize: '1.2rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="streaming-indicator"></span>
                  LIVE STREAM
                </h2>
                <p style={{ color: '#88ff88', fontSize: '0.9rem', marginBottom: '0.25rem' }}>
                  {currentStream.filename || 'Streaming...'}
                </p>
                <p style={{ color: '#666', fontSize: '0.8rem' }}>
                  {rtmpUrl.split('//')[1]}
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '1.5rem', color: '#00ff00', fontWeight: 'bold', fontFamily: 'monospace' }}>
                  {currentStream.progress?.timemark || '00:00:00'}
                </div>
                <div style={{ fontSize: '0.8rem', color: '#888' }}>
                  {currentStream.progress?.currentFps || 0} FPS
                </div>
              </div>
            </div>
            
            {currentStream.progress && (
              <div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: '0%' }}></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', fontSize: '0.75rem', color: '#888' }}>
                  <span>{resolution} @ {bitrate}</span>
                  <span>Audio: {audioBitrate}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Playlist */}
        {selectedPlaylist ? (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', paddingBottom: '0.5rem', borderBottom: '1px solid #333' }}>
              <h2 style={{ color: '#00ff00', fontSize: '1rem', margin: 0 }}>
                {selectedPlaylist.name}
              </h2>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: '#888' }}>
                  {selectedPlaylist.files.length} files
                </span>
                <button
                  className="btn btn-primary btn-small"
                  onClick={() => setShowAddFileDialog(true)}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                >
                  + Add Files
                </button>
                <button
                  className="btn btn-danger btn-small"
                  onClick={() => deletePlaylist(selectedPlaylist.id)}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                >
                  Delete
                </button>
              </div>
            </div>
            
            <div style={{ maxHeight: 'calc(100vh - 500px)', overflowY: 'auto' }}>
              {selectedPlaylist.files.map((filePath, index) => (
                <div
                  key={index}
                  draggable
                  onDragStart={() => setDraggedIndex(index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (draggedIndex !== null) {
                      moveFileInPlaylist(draggedIndex, index);
                      setDraggedIndex(null);
                    }
                  }}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.75rem',
                    background: index === selectedPlaylist.currentIndex && currentStream ? '#001a00' : '#0a0a0a',
                    border: '1px solid',
                    borderColor: index === selectedPlaylist.currentIndex && currentStream ? '#00ff00' : '#222',
                    marginBottom: '0.25rem',
                    borderRadius: '2px',
                    cursor: 'move',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = '#00ff00'}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = index === selectedPlaylist.currentIndex && currentStream ? '#00ff00' : '#222'}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                    <span style={{ color: '#666', fontSize: '0.8rem', minWidth: '25px' }}>
                      {index + 1}.
                    </span>
                    {index === selectedPlaylist.currentIndex && currentStream && (
                      <span className="streaming-indicator"></span>
                    )}
                    <span style={{ fontSize: '0.85rem', color: '#e0e0e0', flex: 1, wordBreak: 'break-word' }}>
                      {filePath.split('/').pop()}
                    </span>
                    {index > 0 && (
                      <span
                        onClick={() => moveToTop(index)}
                        title="Move to top"
                        style={{
                          color: '#666',
                          fontSize: '1rem',
                          cursor: 'pointer',
                          padding: '0 0.5rem',
                          transition: 'color 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.color = '#00ff00'}
                        onMouseLeave={(e) => e.currentTarget.style.color = '#666'}
                      >
                        ↑
                      </span>
                    )}
                  </div>
                  <button
                    className="btn btn-danger btn-small"
                    onClick={() => removeFileFromPlaylist(index)}
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.7rem' }}
                  >
                    X
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: '#666', textAlign: 'center' }}>
            <div>
              <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>No Playlist Selected</p>
              <p style={{ fontSize: '0.9rem' }}>Scan a folder to create a playlist</p>
            </div>
          </div>
        )}

        {/* Other Playlists */}
        {playlists.length > 0 && (
          <div className="card">
            <h3 style={{ color: '#00ff00', fontSize: '0.9rem', marginBottom: '0.75rem', textTransform: 'uppercase' }}>
              All Playlists
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {playlists.map((playlist) => (
                <div
                  key={playlist.id}
                  onClick={() => setSelectedPlaylist(playlist)}
                  style={{
                    padding: '0.75rem',
                    background: selectedPlaylist?.id === playlist.id ? '#001a00' : '#0a0a0a',
                    border: '1px solid',
                    borderColor: selectedPlaylist?.id === playlist.id ? '#00ff00' : '#222',
                    borderRadius: '2px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = '#00ff00'}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = selectedPlaylist?.id === playlist.id ? '#00ff00' : '#222'}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ color: '#e0e0e0', fontSize: '0.9rem', marginBottom: '0.25rem' }}>
                        {playlist.name}
                      </div>
                      <div style={{ color: '#666', fontSize: '0.75rem' }}>
                        {playlist.files.length} files
                      </div>
                    </div>
                    {selectedPlaylist?.id === playlist.id && (
                      <span style={{ color: '#00ff00', fontSize: '0.8rem' }}>[SELECTED]</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Folder Browser Modal */}
      {showFolderBrowser && (
        <FolderBrowser
          onSelectFolder={(path) => {
            setFolderPath(path);
            setShowFolderBrowser(false);
          }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}

      {/* Add Files Dialog */}
      {showAddFileDialog && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: '#1a1a1a',
            border: '2px solid #00ff00',
            borderRadius: '4px',
            padding: '1.5rem',
            maxWidth: '500px',
            width: '90%'
          }}>
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              marginBottom: '1rem',
              paddingBottom: '0.75rem',
              borderBottom: '1px solid #333'
            }}>
              <h3 style={{ color: '#00ff00', margin: 0 }}>
                Add Files to Playlist
              </h3>
              <button
                className="btn btn-danger btn-small"
                onClick={() => setShowAddFileDialog(false)}
              >
                X
              </button>
            </div>

            <p style={{ color: '#aaa', marginBottom: '1rem', fontSize: '0.9rem' }}>
              Select video files from your computer to add to the playlist.
            </p>

            <input
              type="file"
              multiple
              accept="video/*,.mp4,.mkv,.avi,.mov,.flv,.wmv,.webm,.m4v,.mpg,.mpeg,.3gp"
              onChange={addFilesToPlaylist}
              style={{ 
                width: '100%', 
                padding: '0.75rem',
                background: '#0a0a0a',
                border: '1px solid #333',
                borderRadius: '2px',
                color: '#e0e0e0',
                cursor: 'pointer'
              }}
            />

            <p style={{ color: '#666', marginTop: '1rem', fontSize: '0.75rem' }}>
              Note: On web browsers, you can only add files by selecting them. 
              For folder-based playlists, use the "Scan Folder" feature instead.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default UnifiedDashboard;

