import { useEffect, useRef, useState } from 'react';
import { normalizeLogEntry } from '../lib/contracts';

const MAX = 200; // keep the ring small; the panel shows the tail

// Drop anything that isn't a well-formed { src, kind, line } entry.
const clean = (list) => (Array.isArray(list) ? list.map(normalizeLogEntry).filter(Boolean) : []);

/**
 * Live raw-ffmpeg log. Subscribes to the server's `stream:ffmpeg` socket event
 * (status ticks + stderr warnings from both the streamer and the feeder) and
 * keeps a capped ring plus the latest reconstructed streamer status line.
 *
 * `seed` (optional) is the log array from /api/streams, used to backfill when the
 * panel mounts mid-stream so it isn't empty until the next tick. Every entry —
 * seeded or live — is run through normalizeLogEntry so a malformed payload can
 * never reach the panel and throw during render.
 */
export function useFfmpegLog(socket, seed) {
  const [entries, setEntries] = useState(() => clean(seed).slice(-MAX));
  const [lastStatus, setLastStatus] = useState(null);
  const lastSeedRef = useRef(null);

  // Backfill from the snapshot whenever it changes identity — i.e. on first
  // mount and again on each new stream (a fresh /api/streams fetch yields a new
  // log array). Re-seeding (rather than latching once) clears a previous
  // stream's stale tail instead of showing it under the new stream.
  useEffect(() => {
    if (!Array.isArray(seed) || !seed.length || seed === lastSeedRef.current) return;
    lastSeedRef.current = seed;
    const cleaned = clean(seed).slice(-MAX);
    setEntries(cleaned);
    const lastStreamerStatus = [...cleaned].reverse().find((e) => e.src === 'streamer' && e.kind === 'status');
    setLastStatus(lastStreamerStatus ? lastStreamerStatus.line : null);
  }, [seed]);

  useEffect(() => {
    if (!socket) return undefined;
    const onLog = (raw) => {
      const e = normalizeLogEntry(raw);
      if (!e) return;
      setEntries((cur) => {
        const next = cur.length >= MAX ? cur.slice(cur.length - MAX + 1) : cur.slice();
        next.push(e);
        return next;
      });
      if (e.src === 'streamer' && e.kind === 'status') setLastStatus(e.line);
    };
    socket.on('stream:ffmpeg', onLog);
    return () => socket.off('stream:ffmpeg', onLog);
  }, [socket]);

  return { entries, lastStatus };
}
