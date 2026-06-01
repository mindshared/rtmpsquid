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

// Normalise a stored video bitrate to ffmpeg "M" form (e.g. legacy "3000k" -> "3M",
// "1400k" -> "1.4M"); pass through values already in M.
export const toM = (v) => {
  if (!v) return '3M';
  if (/m$/i.test(v)) return v;
  const k = parseFloat(v);
  return Number.isFinite(k) ? `${k / 1000}M` : '3M';
};
