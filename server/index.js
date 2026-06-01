import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { config, ensureDirs } from './config.js';
import { requireAuth, socketAuth, resolveWithinRoot, assertSafeStreamUrl } from './security.js';
import { StreamManager } from './streamManager.js';
import { startStats, getStats } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ensureDirs();

const app = express();
app.set('trust proxy', 'loopback');
const httpServer = createServer(app);

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
  const directories = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const realRoot = fs.realpathSync(config.mediaRoot);
  const parent = fs.realpathSync(dir) !== realRoot ? path.dirname(dir) : null;
  res.json({ success: true, currentPath: dir, parent, directories });
}));

// ---- the one auto-queue ----
app.get('/api/queue', (req, res) => res.json(streamManager.getQueue()));
app.get('/api/library', (req, res) => res.json(streamManager.getLibrary()));

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

app.post('/api/queue/start', h(async (req, res) => {
  const { rtmpUrl, streamKey, ...opts } = req.body;
  if (!rtmpUrl) return res.status(400).json({ error: 'RTMP URL is required' });
  const fullRtmpUrl = assertSafeStreamUrl(streamKey ? `${rtmpUrl}/${streamKey}` : rtmpUrl);
  const result = await streamManager.startQueue(fullRtmpUrl, opts);
  res.json({ success: true, ...result });
}));

app.post('/api/queue/stop', h(async (req, res) => { await streamManager.stopQueue(); res.json({ success: true }); }));

app.post('/api/queue/next', h(async (req, res) => { res.json(streamManager.skipCurrent()); }));

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
  console.log(`🦑 RTMP Squid on http://${config.host}:${config.port}`);
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
