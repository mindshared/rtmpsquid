import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load a project-root .env (KEY=VALUE per line) with no dependency. A real
// environment variable always wins over the file, so it's safe in production.
(function loadEnv() {
  try {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* ignore malformed .env */ }
})();

// Centralised configuration, all overridable via environment variables.
// Defaults target the "localhost / SSH-tunnel only" posture.

let authToken = process.env.AUTH_TOKEN || process.env.DASHBOARD_TOKEN || '';
let authTokenGenerated = false;
if (!authToken) {
  authToken = crypto.randomBytes(24).toString('base64url');
  authTokenGenerated = true;
}

// Portable default: a `media/` folder beside the repo. Override with MEDIA_ROOT.
const mediaRoot = path.resolve(process.env.MEDIA_ROOT || path.join(ROOT, 'media'));

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '3001', 10),

  // The only directory the app may read media from. Everything is confined here.
  mediaRoot,
  // The library the auto-queue draws random movies from (defaults to the media root).
  libraryDir: path.resolve(process.env.LIBRARY_DIR || mediaRoot),

  authToken,
  authTokenGenerated,

  allowedOrigins: (process.env.ALLOWED_ORIGINS ||
    'http://localhost:3001,http://127.0.0.1:3001,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(s => s.trim()).filter(Boolean),

  scanMaxDepth: parseInt(process.env.SCAN_MAX_DEPTH || '12', 10),
  tmpDir: process.env.RTMP_TMP_DIR || os.tmpdir(),

  // Only these protocols are accepted as a stream target (blocks file:// writes).
  allowedStreamProtocols: ['rtmp:', 'rtmps:'],

  videoExtensions: ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg', '.3gp', '.ts', '.m2ts', '.ogv'],

  // Auto-queue: keep at least MIN upcoming; top up toward TARGET when below.
  queueMin: parseInt(process.env.QUEUE_MIN || '5', 10),
  queueTarget: parseInt(process.env.QUEUE_TARGET || '20', 10),

  // Ignore tiny files (samples/junk) when scanning the library.
  minMovieBytes: Math.round(parseFloat(process.env.MIN_MOVIE_MB || '5') * 1024 * 1024),
};

export function ensureDirs() {
  if (!fs.existsSync(config.mediaRoot)) fs.mkdirSync(config.mediaRoot, { recursive: true });
}
