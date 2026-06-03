import { useState, useEffect } from 'react';
import { api } from '../api';
import { fmtBytes } from '../lib/format';

// Two modes, picked by which callback is passed:
//   onSelectFolder → folder picker (choose a library folder)
//   onAddFile      → file picker (cherry-pick one video into the queue, even from
//                    a folder outside the scanned library). Stays open after each
//                    add so several files can be grabbed in one visit.
function FolderBrowser({ onSelectFolder, onAddFile, onClose }) {
  const [currentPath, setCurrentPath] = useState('');
  const [directories, setDirectories] = useState([]);
  const [files, setFiles] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState(() => new Set()); // paths added this session (for the ✓ label)

  const fileMode = typeof onAddFile === 'function';

  const browse = async (dirPath) => {
    setLoading(true);
    try {
      const { data } = await api.post('/api/browse-directory', { directory: dirPath });
      // Coerce defensively: a proxy/login HTML 200 (or any non-JSON body) would
      // otherwise make `.map` throw and blank the browser modal.
      setDirectories(Array.isArray(data?.directories) ? data.directories : []);
      setFiles(Array.isArray(data?.files) ? data.files : []);
      setCurrentPath(data?.currentPath || '');
      setParent(data?.parent ?? null);
    } catch (error) {
      alert(error.response?.data?.error || 'Unable to open directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    browse(undefined);
  }, []); // starts at the media root

  const addFile = (filePath) => {
    onAddFile(filePath);
    setAdded((prev) => new Set(prev).add(filePath));
  };

  const showFiles = fileMode && files.length > 0;
  const empty = directories.length === 0 && !showFiles;

  return (
    <div className="modal-overlay">
      <div className="card modal">
        <div className="card-head">
          <h2 style={{ border: 'none', margin: 0, padding: 0 }}>{fileMode ? 'Add a File' : 'Select Folder'}</h2>
          <button className="btn btn-danger btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="path-bar">{currentPath || 'Media root'}</div>

        <div className="row" style={{ marginBottom: '1rem' }}>
          <button className="btn btn-secondary" onClick={() => browse(parent)} disabled={!parent} style={{ flex: 1 }}>
            Go Up
          </button>
          {!fileMode && (
            <button
              className="btn btn-primary"
              onClick={() => {
                onSelectFolder(currentPath);
                onClose();
              }}
              disabled={!currentPath}
              style={{ flex: 2 }}
            >
              Select This Folder
            </button>
          )}
        </div>

        <div className="dir-list scrollable">
          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : empty ? (
            <div className="empty-state">{fileMode ? 'No subfolders or videos here' : 'No subfolders here'}</div>
          ) : (
            <>
              {directories.map((dir) => (
                <div key={dir.path} className="dir-row">
                  <span className="dir-name">📁 {dir.name}</span>
                  {onSelectFolder && (
                    <button
                      className="btn btn-primary btn-small"
                      onClick={() => {
                        onSelectFolder(dir.path);
                        onClose();
                      }}
                    >
                      Select
                    </button>
                  )}
                  <button className="btn btn-secondary btn-small" onClick={() => browse(dir.path)}>
                    Open
                  </button>
                </div>
              ))}
              {showFiles &&
                files.map((file) => (
                  <div key={file.path} className="dir-row">
                    <span className="dir-name">
                      🎬 {file.name}
                      {file.size ? <span className="muted"> · {fmtBytes(file.size)}</span> : null}
                    </span>
                    <button className="btn btn-primary btn-small" onClick={() => addFile(file.path)}>
                      {added.has(file.path) ? '✓ Add again' : '＋ Add'}
                    </button>
                  </div>
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default FolderBrowser;
