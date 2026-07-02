import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A media root reached THROUGH a symlink, so realpath(candidate) !== candidate —
// the exact condition that broke subtitle selection (server stored the pick under
// the realpath key while the queue/feeder looked it up under the logical path).
const real = fs.mkdtempSync(`${os.tmpdir()}/rtmpsquid-secreal-`);
const link = `${real}-link`;
fs.symlinkSync(real, link);
fs.writeFileSync(path.join(real, 'Movie.mkv'), 'x');

process.env.MEDIA_ROOT = link; // root itself is the symlink
process.env.AUTH_TOKEN = 'test';
const { resolveWithinRoot } = await import('./security.js');

test('realpath:false returns the logical path (matches the queue key)', () => {
  const logical = resolveWithinRoot('Movie.mkv', { realpath: false });
  // Stays under the symlinked root as the queue would have it — NOT collapsed to `real`.
  assert.equal(logical, path.join(link, 'Movie.mkv'));
});

test('default (realpath:true) still collapses symlinks for physical checks', () => {
  const physical = resolveWithinRoot('Movie.mkv');
  assert.equal(physical, path.join(fs.realpathSync(real), 'Movie.mkv'));
});

test('confinement is enforced regardless of the realpath flag', () => {
  assert.throws(() => resolveWithinRoot('../../etc/passwd', { realpath: false }), (e) => e.status === 403 || e.status === 404);
  assert.throws(() => resolveWithinRoot('/etc/passwd', { realpath: false }), (e) => e.status === 403 || e.status === 404);
});

test('cleanup', () => {
  fs.rmSync(real, { recursive: true, force: true });
  fs.rmSync(link, { force: true });
});
