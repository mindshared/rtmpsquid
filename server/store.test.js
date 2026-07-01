import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(`${os.tmpdir()}/rtmpsquid-storetest-`);
process.env.DATA_DIR = dataDir;
process.env.AUTH_TOKEN = 'test';

const { loadState, saveStateNow, stateFilePath } = await import('./store.js');

test('loadState returns null when there is no file yet', () => {
  assert.equal(loadState(), null);
});

test('saveStateNow then loadState round-trips an object', () => {
  saveStateNow({ hello: 'world', n: 7, list: [1, 2, 3] });
  assert.deepEqual(loadState(), { hello: 'world', n: 7, list: [1, 2, 3] });
});

test('write is atomic — no leftover .tmp file', () => {
  saveStateNow({ a: 1 });
  const leftovers = fs.readdirSync(dataDir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('loadState returns null on a corrupt file (start fresh, never throws)', () => {
  fs.writeFileSync(stateFilePath(), '{ this is not json ');
  assert.equal(loadState(), null);
});

test('cleanup', () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
