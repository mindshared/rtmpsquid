import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { config, ensureDirs } from './config.js';
import { requireAuth, socketAuth, resolveWithinRoot, assertSafeStreamUrl } from './security.js';
import { StreamManager } from './streamManager.js';
import { SUBTITLE_EXTENSIONS } from './subtitles.js';
import { startStats, getStats } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ensureDirs();

const app = express();
app.set('trust proxy', 'loopback');

// Serve HTTPS directly when a cert/key pair is configured (e.g. self-signed from
// setup.sh --https); otherwise plain HTTP. socket.io rides the same server, so it
// upgrades to wss automatically. For a *trusted* cert, front this with a TLS proxy.
const tlsReady = config.tlsCert && config.tlsKey && fs.existsSync(config.tlsCert) && fs.existsSync(config.tlsKey);
const httpServer = tlsReady
  ? createHttpsServer({ key: fs.readFileSync(config.tlsKey), cert: fs.readFileSync(config.tlsCert) }, app)
  : createServer(app);

const corsOptions = {
  origin(origin, cb) {
    if (!origin || config.allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false); // deny without throwing a 500

  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
};

const io = new Server(httpServer, { cors: corsOptions });
io.use(socketAuth);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '8mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));

const streamManager = new StreamManager(io);

// Background resource sampler: feeds GET /api/stats and the periodic `stats`
// socket event (Node process + its ffmpeg children + system context).
startStats(io, () => streamManager.getProcPids());

const h = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => {
  res.status(err.status || 500).json({ error: err.message });
});

// ---- public ----
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

// ---- everything below requires the token ----
app.use('/api', requireAuth);

app.get('/api/auth/check', (req, res) => res.json({ ok: true }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', mediaRoot: config.mediaRoot, streams: streamManager.getActiveStreams() }));
app.get('/api/streams', (req, res) => res.json(streamManager.getActiveStreams()));
app.get('/api/stats', (req, res) => res.json(getStats()));

// ---- folder browsing (for the library picker; confined to mediaRoot) ----
app.post('/api/browse-directory', h((req, res) => {
  const dir = resolveWithinRoot(req.body.directory || config.mediaRoot);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const directories = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Video files in this folder too, so a single file can be cherry-picked into
  // the queue even when it lives outside the scanned library folder.
  const videoExts = new Set(config.videoExtensions);
  const files = entries
    .filter((e) => e.isFile() && !e.isSymbolicLink() && !e.name.startsWith('.') &&
      videoExts.has(path.extname(e.name).toLowerCase()))
    .map((e) => {
      const full = path.join(dir, e.name);
      let size = null;
      try { size = fs.statSync(full).size; } catch { /* unreadable — size stays null */ }
      return { name: e.name, path: full, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  // Subtitle files in this folder too, so the subtitle picker can browse to a
  // .srt/.ass/.vtt that doesn't sit right beside its movie.
  const subExts = new Set(SUBTITLE_EXTENSIONS);
  const subtitleFiles = entries
    .filter((e) => e.isFile() && !e.isSymbolicLink() && !e.name.startsWith('.') &&
      subExts.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const realRoot = fs.realpathSync(config.mediaRoot);
  const parent = fs.realpathSync(dir) !== realRoot ? path.dirname(dir) : null;
  res.json({ success: true, currentPath: dir, parent, directories, files, subtitleFiles });
}));

// ---- the one auto-queue ----
app.get('/api/queue', (req, res) => res.json(streamManager.getQueue()));
app.get('/api/library', (req, res) => res.json(streamManager.getLibrary()));

// Park / un-park a library file so the auto-queue skips (or resumes) it.
app.post('/api/library/exclude', h((req, res) => {
  const file = resolveWithinRoot(req.body.filePath);
  const excluded = req.body.excluded !== false; // default to parking
  res.json(streamManager.setExcluded(file, excluded));
}));

app.post('/api/queue/library', h(async (req, res) => {
  const folder = resolveWithinRoot(req.body.folderPath);
  const minSizeMB = req.body.minSizeMB === undefined ? undefined : parseFloat(req.body.minSizeMB);
  res.json(await streamManager.setLibrary(folder, minSizeMB));
}));

app.post('/api/queue/reshuffle', (req, res) => res.json(streamManager.reshuffle()));

app.post('/api/queue/add', h((req, res) => {
  const file = resolveWithinRoot(req.body.filePath);
  const raw = req.body.index;
  const index = (raw === undefined || raw === null || raw === '') ? null : parseInt(raw, 10);
  res.json(streamManager.addToQueue(file, index));
}));

app.delete('/api/queue/:index', (req, res) => res.json(streamManager.removeFromQueue(parseInt(req.params.index, 10))));

app.post('/api/queue/reorder', (req, res) => res.json(streamManager.reorderQueue(req.body.fromIndex, req.body.toIndex)));

// Per-title subtitles. GET lists the auto-detected options for a file; POST sets
// (or clears) the burned-in subtitle and optionally the global font size.
app.get('/api/subtitles', h((req, res) => {
  const file = resolveWithinRoot(req.query.filePath);
  res.json(streamManager.getSubtitleOptions(file));
}));

app.post('/api/queue/subtitle', h((req, res) => {
  const file = resolveWithinRoot(req.body.filePath);
  // A missing `choice` key means "font size only — leave the pick alone"; an
  // explicit null clears it; an object sets it.
  const changeChoice = Object.prototype.hasOwnProperty.call(req.body, 'choice');
  let choice = null;
  const raw = req.body.choice;
  if (raw && raw.kind === 'file' && raw.path) {
    choice = {
      kind: 'file',
      path: resolveWithinRoot(raw.path), // confine the subtitle to the media root too
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : 'Subtitles',
    };
  }
  res.json(streamManager.setSubtitle(file, choice, req.body.fontSize, changeChoice));
}));

app.post('/api/queue/start', h(async (req, res) => {
  const { rtmpUrl, streamKey, ...opts } = req.body;
  if (!rtmpUrl) return res.status(400).json({ error: 'RTMP URL is required' });
  const fullRtmpUrl = assertSafeStreamUrl(streamKey ? `${rtmpUrl}/${streamKey}` : rtmpUrl);
  const result = await streamManager.startQueue(fullRtmpUrl, opts);
  res.json({ success: true, ...result });
}));

app.post('/api/queue/stop', h(async (req, res) => { await streamManager.stopQueue(); res.json({ success: true }); }));

app.post('/api/queue/next', h(async (req, res) => { res.json(streamManager.skipCurrent()); }));

// Live on/off for the bottom-left movie-title overlay (instant, no reconnect).
app.post('/api/queue/title', h((req, res) => res.json(streamManager.setShowTitle(req.body.show))));

// Pause goes offline but remembers the spot; resume reconnects and picks it up.
app.post('/api/queue/pause', h(async (req, res) => { res.json(await streamManager.pauseQueue()); }));
app.post('/api/queue/resume', h(async (req, res) => { res.json({ success: true, ...(await streamManager.resumeQueue()) }); }));

// Live settings push — applies at the next track boundary without dropping
// the RTMP connection. Strips rtmpUrl/streamKey to make accidental ingest
// changes impossible via this path.
app.post('/api/queue/settings', h((req, res) => {
  const { rtmpUrl, streamKey, ...opts } = req.body || {};
  res.json(streamManager.updateSettings(opts));
}));

// Unknown API path → JSON 404 (not the SPA HTML). Must sit after all /api routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- static client ----
app.use(express.static(path.join(__dirname, '../client/dist')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/dist/index.html')));

io.on('connection', (socket) => { socket.on('disconnect', () => {}); });

httpServer.listen(config.port, config.host, () => {
  console.log(`🦑 RTMP Squid on ${tlsReady ? 'https' : 'http'}://${config.host}:${config.port}`);
  console.log(`📁 Media root: ${config.mediaRoot}`);
  console.log(`🎬 Library:    ${config.libraryDir}`);
  if (config.authTokenGenerated) {
    console.log('\n🔑 No AUTH_TOKEN set — generated one for this session:');
    console.log(`   ${config.authToken}`);
    console.log('   Paste it into the dashboard login. Set AUTH_TOKEN in the env to make it permanent.\n');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await streamManager.stopAllStreams().catch(() => {}); process.exit(0); });
}
