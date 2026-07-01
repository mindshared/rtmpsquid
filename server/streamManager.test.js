import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';

// Point the library at an empty temp dir BEFORE importing config (via
// streamManager) so the constructor's auto-load scans nothing real.
const dir = fs.mkdtempSync(`${os.tmpdir()}/rtmpsquid-mgrtest-`);
const dataDir = fs.mkdtempSync(`${os.tmpdir()}/rtmpsquid-mgrdata-`);
process.env.MEDIA_ROOT = dir;
process.env.LIBRARY_DIR = dir;
process.env.DATA_DIR = dataDir;
process.env.AUTH_TOKEN = 'test';

const { StreamManager } = await import('./streamManager.js');
const { loadState, saveStateNow } = await import('./store.js');
const stubIo = { emit() {} };
const mgr = () => new StreamManager(stubIo);

test('getQueue exposes lastIncident (null until something happens)', () => {
  const m = mgr();
  const q = m.getQueue();
  assert.equal(q.lastIncident, null);
  assert.ok('lastIncident' in q);
});

test('_recordIncident normalises fields; clearIncident wipes it', () => {
  const m = mgr();
  m._recordIncident({ reason: 'error', path: '/movies/The Film.mkv', offset: 65.9, message: 'boom', streaming: false });
  const inc = m.getQueue().lastIncident;
  assert.equal(inc.reason, 'error');
  assert.equal(inc.file, 'The Film.mkv'); // derived from path
  assert.equal(inc.path, '/movies/The Film.mkv');
  assert.equal(inc.offset, 65); // floored
  assert.equal(inc.streaming, false);
  assert.ok(typeof inc.at === 'number');

  m.clearIncident();
  assert.equal(m.getQueue().lastIncident, null);
});

test('_recordIncident clamps a negative/garbage offset to 0', () => {
  const m = mgr();
  m._recordIncident({ reason: 'skipped', path: '/x/y.mp4', offset: -12 });
  assert.equal(m.getQueue().lastIncident.offset, 0);
  m._recordIncident({ reason: 'skipped', path: '/x/y.mp4', offset: 'nope' });
  assert.equal(m.getQueue().lastIncident.offset, 0);
});

test('seekTo throws when nothing is streaming', () => {
  const m = mgr();
  assert.throws(() => m.seekTo(30), (e) => e.status === 400);
});

test('recoverIncident rejects with no incident, and with no remembered destination', async () => {
  const m = mgr();
  await assert.rejects(() => m.recoverIncident(0), (e) => e.status === 400); // nothing to recover
  m._recordIncident({ reason: 'error', path: '/movies/Film.mkv', offset: 10, streaming: false });
  await assert.rejects(() => m.recoverIncident(0), (e) => /destination/i.test(e.message)); // no lastRtmpUrl
});

test('resumeQueue rejects when not paused (offset arg is accepted, not required)', async () => {
  const m = mgr();
  await assert.rejects(() => m.resumeQueue(120), (e) => e.status === 400);
});

test('_snapshot captures settings, queue, and stream intent', () => {
  const m = mgr();
  m.order = 'sequential';
  m.autoRestart = false;
  m.subtitleFontSize = 32;
  m.excluded = new Set(['/movies/a.mkv']);
  m.queue = ['/movies/b.mkv', '/movies/c.mkv'];
  m.lastRtmpUrl = 'rtmp://x/y';
  const snap = m._snapshot();
  assert.equal(snap.order, 'sequential');
  assert.equal(snap.autoRestart, false);
  assert.equal(snap.subtitleFontSize, 32);
  assert.deepEqual(snap.excluded, ['/movies/a.mkv']);
  assert.deepEqual(snap.queue, ['/movies/b.mkv', '/movies/c.mkv']);
  assert.equal(snap.stream.wasStreaming, false);
  assert.equal(snap.stream.rtmpUrl, 'rtmp://x/y');
});

test('persistNow writes a snapshot that loadState reads back', () => {
  const m = mgr();
  m.order = 'sequential';
  m.subtitleFontSize = 44;
  m.persistNow();
  const st = loadState();
  assert.equal(st.order, 'sequential');
  assert.equal(st.subtitleFontSize, 44);
});

test('restore applies saved settings and queue (existing files only), no stream', async () => {
  // Two real files so the queue survives the exists() filter; one bogus dropped.
  const f1 = `${dir}/real1.mp4`; const f2 = `${dir}/real2.mp4`;
  fs.writeFileSync(f1, 'x'); fs.writeFileSync(f2, 'x');
  saveStateNow({
    version: 1,
    library: { folder: dir, minMovieMB: 0 },
    excluded: [f2],
    order: 'sequential',
    autoRestart: false,
    subtitleFontSize: 28,
    subtitles: [],
    queue: [f1, f2, `${dir}/gone.mp4`],
    stream: { wasStreaming: false, rtmpUrl: null, options: null, currentFile: null, currentOffset: 0 },
    lastIncident: null,
  });
  const m = mgr();
  await m.restore();
  const q = m.getQueue();
  assert.equal(m.order, 'sequential');
  assert.equal(m.autoRestart, false);
  assert.equal(m.subtitleFontSize, 28);
  assert.ok(q.files.includes(f1));
  assert.ok(!q.files.includes(`${dir}/gone.mp4`)); // missing file dropped
  assert.ok(m.excluded.has(f2));
  assert.equal(q.streaming, false); // wasStreaming false ⇒ no auto-resume
});

test('cleanup', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});
