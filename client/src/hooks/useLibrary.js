import { useEffect, useState } from 'react';
import { api } from '../api';
import { normalizeLibrary } from '../lib/contracts';

/**
 * The movie library list. Fetches /api/library once and keeps it current via the
 * `library:updated` socket broadcast. Returns the library plus a manual refetch.
 */
export function useLibrary(socket) {
  const [library, setLibrary] = useState(() => normalizeLibrary(null));

  const refetch = () =>
    api
      .get('/api/library')
      .then(({ data }) => setLibrary(normalizeLibrary(data)))
      .catch(() => {});

  useEffect(() => {
    refetch();
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const onLib = (lib) => setLibrary(normalizeLibrary(lib));
    socket.on('library:updated', onLib);
    return () => socket.off('library:updated', onLib);
  }, [socket]);

  return { library, refetchLibrary: refetch };
}
