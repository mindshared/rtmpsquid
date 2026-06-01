// @ts-check
// Pure formatting/parsing helpers shared across the dashboard. No React, no JSX,
// no side effects beyond localStorage reads (ls) — trivially testable in isolation.

export const basename = (p) => (p ? (String(p).split(/[/\\]/).pop() ?? '') : '');

export const niceName = (p) =>
  basename(p)
    .replace(/\.[^.]+$/, '')
    .replace(/[._]/g, ' ');

// ms -> HH:MM:SS
export const elapsed = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

// bytes -> compact human size ("266 MB", "1.4 GB"); '' for unknown/invalid.
export const fmtBytes = (b) => {
  if (b == null || !Number.isFinite(b) || b < 0) return '';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${Math.round(b / (1024 * 1024))} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// seconds -> compact clock ("5:20", "1:02:05"); '' for unknown/invalid so the UI
// can simply omit it.
export const fmtDuration = (sec) => {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

// ffmpeg reports the live streamer throughput as e.g. "1234.5kbits/s" (or "N/A"
// before the first frame). Normalise to a tidy "1235k" or null.
export const liveRate = (raw) => {
  if (!raw || raw === 'N/A') return null;
  const m = /([\d.]+)\s*(k|m)?bits\/s/i.exec(raw);
  if (!m) return null;
  const mult = { m: 1000, k: 1, '': 0.001 }[(m[2] || '').toLowerCase()];
  return `${Math.round(parseFloat(m[1]) * mult)}k`;
};

// localStorage read with a default (null-safe).
export const ls = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : v;
  } catch {
    return d;
  }
};

// Normalise a user/stored video-bitrate value into a VALID ffmpeg bitrate string.
// ffmpeg reads a bare number as bits/second, so "-b:v 2" is 2 bit/s ≈ 0 and
// libx264 dies with "bitrate not specified" — but people type "2" meaning 2 Mbps.
// We always attach a unit: a value already carrying k/M/G is kept (unit
// normalised); a bare number < 50 is treated as Mbps and >= 50 as kbps (covers
// the realistic 0.5–50 Mbps / 500–50000 kbps range). Junk falls back to 3M.
export const normalizeBitrate = (v, fallback = '3M') => {
  if (v == null) return fallback;
  const m = /^\s*([\d.]+)\s*([kmg])?/i.exec(String(v));
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') return `${n}k`;
  if (unit === 'm') return `${n}M`;
  if (unit === 'g') return `${n * 1000}M`;
  return n < 50 ? `${n}M` : `${n}k`;
};
