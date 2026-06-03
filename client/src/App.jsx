import { useState, useEffect, useCallback, useRef } from 'react';
import { api, getToken, clearToken, connectSocket, setUnauthorizedHandler } from './api';
import { normalizeQueue, normalizeStatus } from './lib/contracts';
import Dashboard from './components/Dashboard';
import Notification from './components/Notification';
import Login from './components/Login';

function App() {
  const [authed, setAuthed] = useState(false);
  const [booting, setBooting] = useState(true);
  const [socket, setSocket] = useState(null);
  const [queue, setQueue] = useState(null);
  const [streamStatus, setStreamStatus] = useState(null); // rich status from /api/streams
  const [notification, setNotification] = useState(null);
  const streamingRef = useRef(false);

  const notify = useCallback((message, type = 'success') => setNotification({ message, type, id: Date.now() }), []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      setAuthed(false);
    });
    (async () => {
      if (getToken()) {
        try {
          await api.get('/api/auth/check');
          setAuthed(true);
        } catch {
          clearToken();
        }
      }
      setBooting(false);
    })();
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/api/streams');
      setStreamStatus(normalizeStatus(Array.isArray(data) ? data[0] : null));
    } catch {}
  }, []);

  useEffect(() => {
    if (!authed) return;
    const s = connectSocket();
    setSocket(s);

    // Pull authoritative state from REST. Also runs on every (re)connect so a
    // dropped-then-restored socket can't leave the UI showing stale state.
    const resync = () => {
      api
        .get('/api/queue')
        .then(({ data }) => {
          const nq = normalizeQueue(data);
          setQueue(nq);
          streamingRef.current = !!nq?.streaming;
        })
        .catch(() => {});
      fetchStatus();
    };
    resync();
    s.on('connect', resync);
    s.on('connect_error', (e) => {
      if (/unauthor/i.test(e?.message || '')) {
        clearToken();
        setAuthed(false);
      }
    });

    s.on('queue:updated', (q) => {
      const nq = normalizeQueue(q);
      if (!nq) return; // ignore a malformed payload rather than wiping good state
      setQueue(nq);
      if (nq.streaming !== streamingRef.current) {
        streamingRef.current = nq.streaming;
        fetchStatus();
      }
    });
    s.on('stream:progress', (d) =>
      setStreamStatus((cur) =>
        cur ? { ...cur, progress: d, status: cur.status === 'standby' ? 'standby' : 'streaming' } : cur,
      ),
    );
    s.on('stream:standby', () => setStreamStatus((cur) => (cur ? { ...cur, status: 'standby' } : cur)));
    s.on('stream:title', (d) => setStreamStatus((cur) => (cur ? { ...cur, showTitle: d.showTitle } : cur)));
    s.on('stream:reconnecting', (d) => {
      notify(`Reconnecting (attempt ${d.attempt})…`, 'error');
      setStreamStatus((cur) => (cur ? { ...cur, status: 'reconnecting' } : cur));
    });
    s.on('stream:fileskipped', (d) => notify(`Skipped unreadable file: ${d.file || 'unknown'}`, 'error'));
    s.on('stream:error', (d) => {
      notify(`Stream error: ${d.error}`, 'error');
      setStreamStatus(null);
    });
    s.on('stream:stopped', () => {
      setStreamStatus(null);
    });
    s.on('stream:paused', () => {
      setStreamStatus(null);
    });

    return () => s.close();
  }, [authed, fetchStatus, notify]);

  const logout = () => {
    clearToken();
    setAuthed(false);
    if (socket) socket.close();
  };

  if (booting)
    return (
      <div className="login-screen">
        <p style={{ color: '#888' }}>Loading…</p>
      </div>
    );
  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  return (
    <div className="app">
      <Dashboard
        socket={socket}
        queue={queue}
        streamStatus={streamStatus}
        setQueue={setQueue}
        notify={notify}
        onLogout={logout}
        refreshStatus={fetchStatus}
      />
      {notification && (
        <Notification
          key={notification.id}
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
        />
      )}
    </div>
  );
}

export default App;
