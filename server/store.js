import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// Tiny JSON state store so settings, the queue, subtitle picks and the live
// stream survive a restart. One file, atomic writes, debounced so a burst of
// changes (reordering the queue, say) collapses into a single disk write.

const STATE_FILE = path.join(config.dataDir, 'state.json');

export function stateFilePath() {
  return STATE_FILE;
}

// Read the persisted state, or null if there's none / it's unreadable. Never
// throws — a corrupt file just means "start fresh".
export function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

let pending = null;
let timer = null;

function flush() {
  timer = null;
  const obj = pending;
  pending = null;
  if (obj == null) return;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, STATE_FILE); // atomic replace — never leaves a half-written file
  } catch {
    /* best-effort persistence: a failed write must never crash the stream */
  }
}

// Queue a save (debounced ~400ms). The latest snapshot wins.
export function saveState(obj) {
  pending = obj;
  if (timer) return;
  timer = setTimeout(flush, 400);
  if (timer.unref) timer.unref(); // don't keep the process alive just for a pending write
}

// Force any queued (and the given) state to disk immediately — used on shutdown.
export function saveStateNow(obj) {
  if (obj !== undefined) pending = obj;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  flush();
}
