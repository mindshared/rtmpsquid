import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';

// Point the library at an empty temp dir BEFORE importing config (via
// streamManager) so the constructor's auto-load scans nothing real.
const dir = fs.mkdtempSync(`${os.tmpdir()}/rtmpsquid-mgrtest-`);
process.env.MEDIA_ROOT = dir;
process.env.LIBRARY_DIR = dir;
process.env.AUTH_TOKEN = 'test';

const { StreamManager } = await import('./streamManager.js');
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

test('cleanup', () => {
  fs.rmSync(dir, { recursive: true, force: true });
});
