import os from 'os';
import fs from 'fs';

// Lightweight resource sampler — no external deps. Tracks the Node process (via
// process.cpuUsage) and its ffmpeg children (via /proc on Linux), plus system
// context. A background interval keeps a cached snapshot so the /api/stats
// endpoint and the periodic `stats` socket event are O(1) to serve.

const CLK_TCK = 100; // USER_HZ on Linux (sysconf(_SC_CLK_TCK)); 100 on essentially all distros
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

let lastNode = null; // { cpu: process.cpuUsage(), t: hrtime ns }
const lastProc = new Map(); // pid -> { jiffies, tMs }
let snapshot = emptySnapshot();
let timer = null;

function emptySnapshot() {
  return {
    t: 0,
    node: { pid: process.pid, cpuPct: null, rssBytes: 0 },
    ffmpeg: [],
    total: { cpuPct: null, rssBytes: 0 },
    system: { cores: os.cpus().length, loadavg: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem() },
  };
}

// utime+stime (jiffies) from /proc/<pid>/stat. The comm field (2) can contain
// spaces/parens, so parse the fields after the final ')'.
function procJiffies(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = parseInt(rest[11], 10); // field 14
    const stime = parseInt(rest[12], 10); // field 15
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return utime + stime;
  } catch {
    return null;
  }
}

function procRss(pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? parseInt(m[1], 10) * 1024 : null;
  } catch {
    return null;
  }
}

// % of ONE core for a pid since the last sample (null on the first sample or if
// the process is gone).
function pidCpuPct(pid, nowMs) {
  const jiffies = procJiffies(pid);
  if (jiffies == null) {
    lastProc.delete(pid);
    return null;
  }
  const prev = lastProc.get(pid);
  lastProc.set(pid, { jiffies, tMs: nowMs });
  if (!prev || nowMs <= prev.tMs) return null;
  const dCpuSec = (jiffies - prev.jiffies) / CLK_TCK;
  return Math.max(0, (dCpuSec / ((nowMs - prev.tMs) / 1000)) * 100);
}

function tick(io, getPids) {
  // Node process CPU% (own process only — children are measured via /proc).
  const nowNs = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  let nodeCpuPct = null;
  if (lastNode) {
    const dWallUs = Number(nowNs - lastNode.t) / 1000;
    const dCpuUs = cpu.user + cpu.system - (lastNode.cpu.user + lastNode.cpu.system);
    if (dWallUs > 0) nodeCpuPct = Math.max(0, (dCpuUs / dWallUs) * 100);
  }
  lastNode = { cpu, t: nowNs };

  const nowMs = Date.now();
  let pids = [];
  try { pids = getPids() || []; } catch { pids = []; }
  const alive = new Set();
  const ffmpeg = [];
  for (const { role, pid } of pids) {
    if (!pid) continue;
    alive.add(pid);
    const rssBytes = procRss(pid);
    if (rssBytes == null) { lastProc.delete(pid); continue; } // dead/unreadable
    ffmpeg.push({ role, pid, cpuPct: round(pidCpuPct(pid, nowMs)), rssBytes });
  }
  // Drop baselines for pids we're no longer tracking.
  for (const pid of [...lastProc.keys()]) if (!alive.has(pid)) lastProc.delete(pid);

  const nodeRss = process.memoryUsage().rss;
  const ffCpu = ffmpeg.reduce((a, p) => a + (p.cpuPct || 0), 0);
  const ffRss = ffmpeg.reduce((a, p) => a + (p.rssBytes || 0), 0);

  snapshot = {
    t: nowMs,
    node: { pid: process.pid, cpuPct: round(nodeCpuPct), rssBytes: nodeRss },
    ffmpeg,
    total: { cpuPct: round((nodeCpuPct || 0) + ffCpu), rssBytes: nodeRss + ffRss },
    system: { cores: os.cpus().length, loadavg: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem() },
  };
  if (io) io.emit('stats', snapshot);
}

// Start the background sampler. getPids() returns [{ role, pid }] for the live
// ffmpeg processes (or []). Safe to call once at boot.
export function startStats(io, getPids, intervalMs = 2000) {
  if (timer) return;
  lastNode = { cpu: process.cpuUsage(), t: process.hrtime.bigint() };
  tick(io, getPids); // primes per-proc baselines (cpu pct is null on this first pass)
  timer = setInterval(() => tick(io, getPids), intervalMs);
  if (timer.unref) timer.unref(); // never keep the process alive for stats
}

export function getStats() {
  return snapshot;
}
