import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import axios from 'axios';
import UnifiedDashboard from './components/UnifiedDashboard';
import Notification from './components/Notification';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function App() {
  const [socket, setSocket] = useState(null);
  const [activeStreams, setActiveStreams] = useState([]);
  const [notification, setNotification] = useState(null);

  useEffect(() => {
    const newSocket = io(API_URL);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Connected to server');
    });

    newSocket.on('stream:started', (data) => {
      showNotification('Stream started successfully', 'success');
      fetchActiveStreams();
    });

    newSocket.on('stream:ended', (data) => {
      showNotification('Stream ended', 'success');
      fetchActiveStreams();
    });

    newSocket.on('stream:error', (data) => {
      showNotification(`Stream error: ${data.error}`, 'error');
      fetchActiveStreams();
    });

    newSocket.on('stream:progress', (data) => {
      setActiveStreams(prev => 
        prev.map(stream => 
          stream.id === data.streamId 
            ? { ...stream, progress: data }
            : stream
        )
      );
    });

    return () => newSocket.close();
  }, []);

  useEffect(() => {
    fetchActiveStreams();
  }, []);

  const fetchActiveStreams = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/streams`);
      setActiveStreams(response.data);
    } catch (error) {
      console.error('Error fetching streams:', error);
    }
  };

  const handleStartStream = async (rtmpUrl, streamKey, loop, advancedOptions, selectedPlaylist) => {
    if (!selectedPlaylist) {
      showNotification('Please select a playlist first', 'error');
      return;
    }

    try {
      const response = await axios.post(
        `${API_URL}/api/playlists/${selectedPlaylist.id}/stream`,
        {
          rtmpUrl,
          streamKey,
          ...advancedOptions
        }
      );
      showNotification('Stream started!', 'success');
      fetchActiveStreams();
      return response.data;
    } catch (error) {
      showNotification(`Error: ${error.response?.data?.error || error.message}`, 'error');
      throw error;
    }
  };

  const handleStopStream = async (streamId) => {
    try {
      await axios.post(`${API_URL}/api/stream/stop/${streamId}`);
      showNotification('Stream stopped', 'success');
      fetchActiveStreams();
    } catch (error) {
      showNotification('Error stopping stream', 'error');
    }
  };

  const showNotification = (message, type) => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  return (
    <div className="app">
      <header className="header" style={{ marginBottom: '1.5rem', paddingBottom: '1rem' }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>🦑 RTMP SQUID</h1>
        <p style={{ fontSize: '0.9rem' }}>Stream video playlists to RTMP servers</p>
      </header>

      <UnifiedDashboard
        socket={socket}
        onStartStream={handleStartStream}
        onStopStream={handleStopStream}
        activeStreams={activeStreams}
      />

      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
        />
      )}
    </div>
  );
}

export default App;

