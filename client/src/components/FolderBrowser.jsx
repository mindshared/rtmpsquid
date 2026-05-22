import { useState, useEffect } from 'react';
import { api } from '../api';

function FolderBrowser({ onSelectFolder, onClose }) {
  const [currentPath, setCurrentPath] = useState('');
  const [directories, setDirectories] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);

  const browse = async (dirPath) => {
    setLoading(true);
    try {
      const { data } = await api.post('/api/browse-directory', { directory: dirPath });
      setDirectories(data.directories);
      setCurrentPath(data.currentPath);
      setParent(data.parent);
    } catch (error) {
      alert(error.response?.data?.error || 'Unable to open directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { browse(undefined); }, []); // starts at the media root

  return (
    <div className="modal-overlay">
      <div className="card modal">
        <div className="card-head">
          <h2 style={{ border: 'none', margin: 0, padding: 0 }}>Select Folder</h2>
          <button className="btn btn-danger btn-small" onClick={onClose}>✕</button>
        </div>

        <div className="path-bar">{currentPath || 'Media root'}</div>

        <div className="row" style={{ marginBottom: '1rem' }}>
          <button className="btn btn-secondary" onClick={() => browse(parent)} disabled={!parent} style={{ flex: 1 }}>Go Up</button>
          <button className="btn btn-primary" onClick={() => { onSelectFolder(currentPath); onClose(); }} disabled={!currentPath} style={{ flex: 2 }}>Select This Folder</button>
        </div>

        <div className="dir-list scrollable">
          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : directories.length === 0 ? (
            <div className="empty-state">No subfolders here</div>
          ) : (
            directories.map((dir) => (
              <div key={dir.path} className="dir-row">
                <span className="dir-name">📁 {dir.name}</span>
                <button className="btn btn-primary btn-small" onClick={() => { onSelectFolder(dir.path); onClose(); }}>Select</button>
                <button className="btn btn-secondary btn-small" onClick={() => browse(dir.path)}>Open</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default FolderBrowser;
