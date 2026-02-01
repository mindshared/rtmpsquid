import { useState, useEffect } from 'react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function FolderBrowser({ onSelectFolder, onClose }) {
  const [currentPath, setCurrentPath] = useState('');
  const [directories, setDirectories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [parent, setParent] = useState(null);

  useEffect(() => {
    loadHomeDirectories();
  }, []);

  const loadHomeDirectories = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/browse-home`);
      setDirectories(response.data.directories);
      setCurrentPath('');
      setParent(null);
    } catch (error) {
      console.error('Error loading home directories:', error);
      alert('Error loading directories');
    } finally {
      setLoading(false);
    }
  };

  const selectFolder = (dirPath, dirName) => {
    console.log('Selected folder:', dirPath);
    onSelectFolder(dirPath);
    onClose();
  };

  const browseDirectory = async (dirPath) => {
    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/api/browse-directory`, {
        directory: dirPath
      });
      setDirectories(response.data.directories);
      setCurrentPath(response.data.currentPath);
      setParent(response.data.parent);
    } catch (error) {
      console.error('Error browsing directory:', error);
      alert('Error loading directory. Make sure you have permission to access it.');
    } finally {
      setLoading(false);
    }
  };

  const goUp = () => {
    if (parent) {
      browseDirectory(parent);
    } else {
      loadHomeDirectories();
    }
  };

  const selectCurrentFolder = () => {
    if (currentPath && currentPath !== 'Quick Access' && currentPath !== '') {
      console.log('Selecting current folder:', currentPath);
      onSelectFolder(currentPath);
      onClose();
    } else {
      alert('Please navigate into a folder first, or click a folder name directly to select it');
    }
  };

  return (
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
        maxWidth: '700px',
        width: '90%',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {/* Header */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginBottom: '1rem',
          paddingBottom: '0.75rem',
          borderBottom: '1px solid #333'
        }}>
          <h3 style={{ color: '#00ff00', margin: 0 }}>
            Select Folder
          </h3>
          <button
            className="btn btn-danger btn-small"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Current Path */}
        <div style={{
          background: '#0a0a0a',
          border: '1px solid #333',
          borderRadius: '2px',
          padding: '0.75rem',
          marginBottom: '1rem',
          fontFamily: 'monospace',
          color: '#00ff00',
          fontSize: '0.875rem',
          wordBreak: 'break-all',
          minHeight: '2.5rem'
        }}>
          {currentPath ? currentPath : 'Quick Access - Click a folder below to select or browse'}
        </div>

        {/* Navigation Buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <button
            className="btn btn-secondary"
            onClick={goUp}
            disabled={!parent}
            style={{ flex: 1 }}
          >
            Go Up
          </button>
          <button
            className="btn btn-primary"
            onClick={selectCurrentFolder}
            disabled={!currentPath}
            style={{ flex: 2 }}
          >
            Select This Folder
          </button>
        </div>

        {/* Directory List */}
        <div style={{ 
          flex: 1, 
          overflowY: 'auto', 
          border: '1px solid #333',
          borderRadius: '2px',
          background: '#0a0a0a'
        }}>
          {loading ? (
            <div style={{ 
              padding: '2rem', 
              textAlign: 'center', 
              color: '#888' 
            }}>
              Loading...
            </div>
          ) : directories.length === 0 ? (
            <div style={{ 
              padding: '2rem', 
              textAlign: 'center', 
              color: '#888' 
            }}>
              No subdirectories found
            </div>
          ) : (
            directories.map((dir, index) => (
              <div
                key={index}
                style={{
                  padding: '0.75rem 1rem',
                  borderBottom: index < directories.length - 1 ? '1px solid #222' : 'none',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  background: 'transparent'
                }}
              >
                <span style={{ fontSize: '1.2rem' }}>[DIR]</span>
                <span 
                  style={{ color: '#e0e0e0', flex: 1 }}
                >
                  {dir.name}
                </span>
                <button
                  className="btn btn-primary btn-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectFolder(dir.path, dir.name);
                  }}
                  style={{ 
                    padding: '0.25rem 0.75rem',
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap'
                  }}
                >
                  Select
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    browseDirectory(dir.path);
                  }}
                  style={{ 
                    padding: '0.25rem 0.75rem',
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap'
                  }}
                >
                  Browse
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer Help */}
        <div style={{ 
          marginTop: '1rem', 
          padding: '0.75rem',
          background: '#0a0a0a',
          border: '1px solid #333',
          borderRadius: '2px',
          fontSize: '0.75rem',
          color: '#888'
        }}>
          Click Select to choose a folder, or click Browse to open it
        </div>
      </div>
    </div>
  );
}

export default FolderBrowser;

