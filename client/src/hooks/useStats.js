import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Live resource snapshot (Node process + its ffmpeg children + system context).
 * Seeds once from GET /api/stats, then updates from the periodic `stats` socket
 * event the server emits every couple of seconds.
 */
export function useStats(socket) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api
      .get('/api/stats')
      .then(({ data }) => {
        if (data && typeof data === 'object') setStats(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const onStats = (s) => {
      if (s && typeof s === 'object') setStats(s);
    };
    socket.on('stats', onStats);
    return () => socket.off('stats', onStats);
  }, [socket]);

  return stats;
}
