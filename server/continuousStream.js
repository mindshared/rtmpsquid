import { spawn, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { subtitleFilterFragment, subtitlesFilterAvailable } from './subtitles.js';

// Locate a usable font for the standby slate's text (optional — we fall back
// to a plain colour card if none is found).
const SLATE_FONT = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
].find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;

const SLATE_CHUNK_SECONDS = 8; // how long each slate segment runs before re-checking for content

const HEALTHY_RUN_MS = 60_000;   // a streamer alive at least this long resets the reconnect backoff
const RECONNECT_BASE_MS = 2_000; // first reconnect delay; doubles each consecutive failure
const RECONNECT_MAX_MS = 15_000; // backoff ceiling
const RESUME_REWIND_S = 2;       // rewind a touch when resuming so we don't skip past content

// Stall detection. A flaky/half-open RTMP link often does NOT make ffmpeg exit —
// the socket write just blocks forever (output frozen, the dashboard bitrate
// creeps up as buffered data is divided by a stuck clock). The exit-based
// reconnect can't see that, so a watchdog forces a reconnect when the streamer
// stops reporting progress, and -rw_timeout makes ffmpeg give up on a wedged
// socket on its own as a backstop.
const STALL_TIMEOUT_MS = 12_000; // no streamer progress for this long ⇒ link is hung ⇒ reconnect
const STALL_CHECK_MS = 3_000;    // how often the watchdog polls
const RW_TIMEOUT_US = 20_000_000; // ffmpeg socket read/write timeout for the RTMP output (µs)

// Coerce a video-bitrate value into a VALID ffmpeg bitrate string. ffmpeg reads a
// bare number as bits/second, so "-b:v 2" is ~0 and libx264 aborts with "bitrate
// not specified" (surfacing in the UI as a bogus "skipped unreadable file"). We
// always attach a unit: values with k/M/G are kept; a bare number < 50 is Mbps
// and >= 50 is kbps; junk/zero falls back. Defends against a stale client or a
// direct API call sending a unitless number; the client normalises too.
function normalizeVideoBitrate(v, fallback = '3000k') {
  if (v == null) return fallback;
  const m = /^\s*([\d.]+)\s*([kmg])?/i.exec(String(v));
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const u = (m[2] || '').toLowerCase();
  if (u === 'k') return `${n}k`;
  if (u === 'm') return `${n}M`;
  if (u === 'g') return `${n * 1000}M`;
  return n < 50 ? `${n}M` : `${n}k`;
}

// Convert an ffmpeg bitrate string ("3M", "1.5M", "3000k", or bare bits) to kbps,
// so we can derive bufsize regardless of which suffix the setting uses.
function bitrateToKbps(s) {
  const m = /^([\d.]+)\s*([kmg]?)/i.exec(String(s).trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'g': return Math.round(n * 1_000_000);
    case 'm': return Math.round(n * 1_000);
    case 'k': return Math.round(n);
    default:  return Math.round(n / 1_000); // bare value = bits/s
  }
}

// Tokenize a free-text args string into an argv array, honouring single/double
// quotes (e.g. -x264-params "keyint=50:scenecut=0" -> two tokens). Used for the
// Advanced-mode "extra ffmpeg args" escape hatch. No shell is involved (we spawn
// with an argv array), so this can't inject shell commands.
function parseArgString(s) {
  if (!s || typeof s !== 'string') return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Merge Advanced-mode overrides over the platform-safe defaults (Twitch/Kick/
// AngelThump: x264 High, CBR, 2s keyframes, yuv420p, 48k AAC). Anything omitted
// or blank falls back to the default. Values are coerced/sanity-checked but the
// extraArgs field is intentionally open-ended (power user).
function normalizeEncode(adv = {}) {
  const a = adv && typeof adv === 'object' ? adv : {};
  const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  return {
    preset: a.preset || 'veryfast',
    profile: a.profile || 'high',          // 'none'/'' -> omitted
    // zerolatency: emit each frame as soon as it's encoded (no lookahead/thread
    // buffering) so output to the FIFO is smooth at the -re pace rather than
    // bursty — keeps RTMP delivery even, which platforms' players need.
    tune: a.tune || 'zerolatency',         // 'none'/'' -> omitted
    level: a.level || '',                   // '' -> omitted
    pixfmt: a.pixfmt || 'yuv420p',
    gopSeconds: num(a.gopSeconds, 2) > 0 ? num(a.gopSeconds, 2) : 2,
    bframes: Math.max(0, int(a.bframes, 0)),
    sceneCut: int(a.sceneCut, 0),
    rateControl: ['cbr', 'vbr', 'crf'].includes(a.rateControl) ? a.rateControl : 'cbr',
    crf: int(a.crf, 23),
    maxrate: a.maxrate || '',               // '' -> = video bitrate
    bufsize: a.bufsize || '',               // '' -> = 2x video bitrate
    audioCodec: a.audioCodec || 'aac',
    audioSampleRate: String(a.audioSampleRate || '48000'),
    extraArgs: typeof a.extraArgs === 'string' ? a.extraArgs : '',
  };
}

/**
 * A single never-stopping RTMP stream.
 *
 * One persistent "streamer" ffmpeg holds the RTMP connection for the whole
 * session. It reads a continuous MPEG-TS byte stream from a FIFO. We feed that
 * FIFO with a sequence of short-lived "feeder" ffmpeg processes — one per
 * playlist file (and a standby slate when there is nothing to play). Because a
 * Node-held write fd keeps the FIFO open, the streamer never sees EOF between
 * feeders, so the connection to the platform is never dropped.
 */
export class ContinuousStream extends EventEmitter {
  constructor({ id, rtmpUrl, options = {}, nextFile, subtitleFor = null, playlistId = null }) {
    super();
    this.id = id || crypto.randomUUID();
    this.rtmpUrl = rtmpUrl;
    this.playlistId = playlistId;
    this.nextFile = nextFile; // () => string | null  (next file path, or null for standby)
    // () => { safePath, fontSize } | null for a given content file — resolves the
    // per-title burned-in subtitle at feed time, so a choice made mid-stream takes
    // effect when that title next starts (no reconnect).
    this.subtitleFor = subtitleFor;

    const [w, h] = (options.resolution || '1920x1080').split('x').map(n => parseInt(n, 10));
    this.opt = {
      width: w || 1920,
      height: h || 1080,
      fps: parseInt(options.fps, 10) || 30,
      videoBitrate: normalizeVideoBitrate(options.bitrate),
      audioBitrate: options.audioBitrate || '160k',
      audioChannels: parseInt(options.audioChannels, 10) || 2,
      // 'fit' = letterbox/pillarbox with bars; 'stretch' = distort to fill;
      // 'crop' = zoom to fill then crop overflow. forceStretch kept for back-compat.
      fit: options.fit || (options.forceStretch ? 'stretch' : 'fit'),
      startTime: options.startTime || null,
    };

    // Advanced-mode encode overrides (or platform-safe defaults when absent).
    this.enc = normalizeEncode(options.advanced);

    // Whether the bottom-left movie-name overlay is shown. The drawtext filter is
    // always in the content filtergraph (reload=1), so this is toggled live just
    // by writing the title — or an empty string — to titleFile. Default on.
    this.showTitle = options.showTitle !== false;

    this.fifoPath = path.join(config.tmpDir, `rtmpsquid-${this.id}.ts`);
    // Holds the current movie's title for the bottom-left overlay. We write the
    // name here and point drawtext at it via textfile= so filenames with colons,
    // quotes, %, etc. don't need filtergraph-level escaping.
    this.titleFile = path.join(config.tmpDir, `rtmpsquid-${this.id}-title.txt`);
    this.holderFd = null;
    this.streamer = null;
    this.feeder = null;
    this.feederKind = null;   // 'content' | 'slate'
    this.currentFile = null;
    this.status = 'idle';     // idle | streaming | standby | stopping | stopped | error
    this.startedAt = null;
    this.progress = {};
    this.stopping = false;
    this.firstFeed = true;

    // Auto-restart on unexpected streamer (RTMP) death. When on, we reconnect
    // indefinitely with backoff and resume the SAME file at the SAME offset; a
    // healthy run resets the backoff so a long session with occasional blips is
    // never killed for good. When off, an unexpected death ends the stream.
    // An explicit stop() always wins regardless of this flag.
    this.autoRestart = options.autoRestart !== false;
    this._reconnects = 0;          // consecutive reconnects (backoff; reset after a healthy run)
    this.streamerStartedAt = null; // wall-clock the current streamer was spawned
    this.lastProgressAt = null;    // wall-clock of the last streamer -progress tick (stall watchdog)
    this.watchdog = null;          // interval handle for the stall watchdog

    // Playback-position tracking, so a reconnect (or pause/resume) can pick the
    // current file back up where it left off instead of jumping to the next one.
    this.feederStartedAt = null;   // wall-clock the current feeder began
    this.feederSeek = 0;           // seconds seeked into the current content file at feed time
    this.tsOffset = 0;             // running output-timestamp base (seconds) — keeps the
                                   // concatenated MPEG-TS monotonic across feeders so the
                                   // streamer's copy doesn't feed the muxer backwards DTS.
    this._resumeSeek = null;       // offset to resume the current file at after a drop

    this._intentionalSkip = false; // set when the user hits Next, so the early
                                   // feeder exit isn't logged as an unreadable skip
    this._consecFails = 0;         // consecutive instant feeder failures (for backoff)

    // Raw-ffmpeg visibility: a rolling ring of recent status ticks + stderr
    // warnings from BOTH ffmpegs, so the dashboard can show exactly what ffmpeg
    // is doing/saying right now (and we can catch a stuck-clock bitrate creep in
    // the act). Capped so a long session can't grow it without bound.
    this.log = [];                 // [{ t, src: 'streamer'|'feeder', kind: 'status'|'log', line }]
    this.lastStatus = null;        // most recent reconstructed streamer status line
    this._feederLastOutSec = null; // last output PTS the running feeder emitted, for
                                   // content-accurate timeline stitching across files
  }

  // Append a raw ffmpeg line (status tick or stderr) to the rolling log and push
  // it live to listeners. Kept small; the UI shows the tail.
  _pushLog(src, kind, line) {
    if (!line) return;
    const entry = { t: Date.now(), src, kind, line: String(line).slice(0, 500) };
    this.log.push(entry);
    if (this.log.length > 250) this.log.splice(0, this.log.length - 250);
    this.emit('ffmpeglog', { streamId: this.id, playlistId: this.playlistId, ...entry });
  }

  // Reconstruct ffmpeg's familiar one-line status from the -progress key/values
  // (we run -nostats so that line isn't printed; this gives the user the same
  // "frame=… time=… bitrate=… speed=…" they'd see on a console, plus drop/dup).
  _statusLine(p) {
    const kb = p.totalSize ? `${Math.round(p.totalSize / 1024)}kB` : 'N/A';
    const t = p.outTime || (p.timeMs ? new Date(p.timeMs).toISOString().substr(11, 12) : 'N/A');
    return `frame=${p.frame} fps=${(p.fps || 0).toFixed(0)} size=${kb} time=${t} `
      + `bitrate=${p.bitrate || 'N/A'} speed=${p.speed || 'N/A'} drop=${p.dropFrames} dup=${p.dupFrames}`;
  }

  // Hot-swap encode settings without touching the running feeder or streamer.
  // Builders read from this.opt / this.enc each time _feedNext spawns a feeder,
  // so the new values pick up at the next file boundary. The persistent RTMP
  // connection (and the FIFO writer fd) are untouched, so viewers don't reconnect.
  // Caller passes the same options shape as the constructor; rtmpUrl is ignored
  // here (changing the ingest destination requires a full restart).
  updateOptions(options = {}) {
    const cur = this.opt;
    const [w, h] = String(options.resolution || `${cur.width}x${cur.height}`).split('x').map((n) => parseInt(n, 10));
    const nextOpt = {
      width: w || cur.width,
      height: h || cur.height,
      fps: parseInt(options.fps, 10) || cur.fps,
      videoBitrate: options.bitrate ? normalizeVideoBitrate(options.bitrate) : cur.videoBitrate,
      audioBitrate: options.audioBitrate || cur.audioBitrate,
      audioChannels: parseInt(options.audioChannels, 10) || cur.audioChannels,
      fit: options.fit || cur.fit,
      startTime: cur.startTime,
    };
    const nextEnc = normalizeEncode(options.advanced);
    this.opt = nextOpt;
    this.enc = nextEnc;
    if (options.autoRestart !== undefined) this.autoRestart = options.autoRestart !== false;
    if (options.showTitle !== undefined) this.setShowTitle(options.showTitle);
  }

  // Live-toggle the bottom-left title overlay. drawtext reads titleFile every
  // frame (reload=1), so rewriting it shows/hides the label within the current
  // track — no feeder restart, no reconnect. The choice sticks for later tracks.
  setShowTitle(show) {
    this.showTitle = show !== false;
    if (this.feederKind === 'content' && this.currentFile) {
      const name = this.showTitle ? path.basename(this.currentFile, path.extname(this.currentFile)) : '';
      try { fs.writeFileSync(this.titleFile, name); } catch {}
    }
    return this.showTitle;
  }

  // Seconds played into the current content file right now (seek + wall-clock
  // elapsed, since -re plays at realtime). Used to resume in place.
  _currentContentOffset() {
    if (this.feederKind !== 'content' || this.feederStartedAt == null) return 0;
    return (this.feederSeek || 0) + Math.max(0, (Date.now() - this.feederStartedAt) / 1000);
  }

  // Snapshot for pause/resume: which file and how far in.
  getResumeState() {
    return { file: this.currentFile, offset: this._currentContentOffset() };
  }

  // ---- ffmpeg argument builders -------------------------------------------

  _videoFilter(overlayTitle = false, subFragment = null) {
    const { width: W, height: H, fps, fit } = this.opt;
    let scale;
    if (fit === 'stretch') {
      // Distort to exactly fill the frame (ignore source aspect ratio). Plain
      // scale does this — note ffmpeg has no force_original_aspect_ratio=ignore.
      scale = `scale=${W}:${H}`;
    } else if (fit === 'crop') {
      // Zoom to fill the frame, then crop the centred overflow — no bars, no distortion.
      scale = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    } else {
      scale = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
    }
    let vf = `${scale},setsar=1,fps=${fps},format=yuv420p`;
    // Burned-in subtitles for this title (after scaling, so they render at output
    // resolution). subFragment is prebuilt by the caller from the resolved temp .srt.
    if (subFragment) vf += `,${subFragment}`;
    // Small, unobtrusive movie-name label in the bottom-left corner. Reads the
    // title from this.titleFile (written per-file in _spawnFeeder) so no escaping
    // is needed; skipped if no usable font was found.
    if (overlayTitle && SLATE_FONT) {
      const pad = Math.round(H / 30);
      vf += `,drawtext=fontfile='${SLATE_FONT}':textfile='${this.titleFile}':reload=1`
        + `:fontcolor=white@0.85:fontsize=${Math.round(H / 40)}`
        + `:x=${pad}:y=h-text_h-${pad}:shadowcolor=black@0.7:shadowx=2:shadowy=2`;
    }
    return vf;
  }

  // Output options shared by every feeder, built from this.enc. Defaults satisfy
  // Twitch / Kick / AngelThump at once (x264 High, true CBR via nal-hrd=cbr —
  // Kick rejects VBR and Twitch wants CBR — fixed 2s keyframes, yuv420p, 48k
  // AAC-LC). Advanced mode overrides any of these; the extraArgs escape hatch is
  // spliced in just before the (fixed) FIFO output target. -bf 0 keeps DTS == PTS
  // so the concatenated TS the streamer copies stays monotonic across files.
  _feederOutputArgs() {
    const { fps, videoBitrate, audioBitrate, audioChannels } = this.opt;
    const e = this.enc;
    const gop = Math.max(1, Math.round(e.gopSeconds * fps));
    const maxrate = e.maxrate || videoBitrate;
    const bufsize = e.bufsize || `${bitrateToKbps(videoBitrate) * 2}k`;

    const v = ['-c:v', 'libx264', '-preset', e.preset, '-bf', String(e.bframes)];
    if (e.profile && e.profile !== 'none') v.push('-profile:v', e.profile);
    if (e.tune && e.tune !== 'none') v.push('-tune', e.tune);
    if (e.level && e.level !== 'none') v.push('-level', e.level);

    if (e.rateControl === 'crf') {
      v.push('-crf', String(e.crf));
      if (e.maxrate) v.push('-maxrate', maxrate, '-bufsize', bufsize); // optional capped-CRF
    } else if (e.rateControl === 'vbr') {
      v.push('-b:v', videoBitrate, '-maxrate', maxrate, '-bufsize', bufsize);
    } else { // cbr
      v.push('-b:v', videoBitrate, '-maxrate', maxrate, '-bufsize', bufsize, '-x264opts', 'nal-hrd=cbr');
    }

    v.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', String(e.sceneCut), '-pix_fmt', e.pixfmt);

    const a = ['-c:a', e.audioCodec, '-b:a', audioBitrate, '-ar', e.audioSampleRate, '-ac', String(audioChannels)];

    return [...v, ...a, ...parseArgString(e.extraArgs),
      '-output_ts_offset', this.tsOffset.toFixed(3), '-f', 'mpegts', this.fifoPath];
  }

  // ---- lifecycle -----------------------------------------------------------

  async start() {
    // Create the FIFO and pin a writer open so the reader never hits EOF.
    try { fs.unlinkSync(this.fifoPath); } catch {}
    execFileSync('mkfifo', [this.fifoPath]);
    this.holderFd = fs.openSync(this.fifoPath, 'r+');

    this._spawnStreamer();
    this.startedAt = Date.now();
    this._feedNext();
    return this.id;
  }

  _spawnStreamer() {
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+genpts+igndts',
      '-f', 'mpegts', '-i', this.fifoPath,
      '-c', 'copy',
      // flush_packets keeps the muxer from hoarding a backlog (which is what makes
      // the reported bitrate balloon when the link stalls); rw_timeout makes a
      // wedged socket error out instead of blocking the process forever.
      '-f', 'flv', '-flush_packets', '1',
      '-progress', 'pipe:1', '-nostats',
      '-rw_timeout', String(RW_TIMEOUT_US),
      this.rtmpUrl,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.streamer = proc;
    this.streamerStartedAt = Date.now();
    this.lastProgressAt = Date.now();
    this._startWatchdog();

    let progBuf = {};
    let prevUs = 0;   // previous tick's out_time (µs) and total bytes, for an
    let prevSize = 0; // INSTANTANEOUS rate — ffmpeg's own bitrate= is a cumulative
    let instBitrate = null; // session average that barely moves when settings change
    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (key === 'progress') {
          this.lastProgressAt = Date.now(); // feeds the stall watchdog
          // Forward the FULL ffmpeg status, not just a few fields. out_time vs
          // total_size is the key pair: if the link wedges, out_time freezes
          // while total_size keeps climbing and the reported bitrate balloons —
          // exposing that here is how we catch the "bitrate creeps to 3M" bug.
          const outTimeUs = parseInt(progBuf.out_time_us || progBuf.out_time_ms || '0', 10);
          const totalSize = parseInt(progBuf.total_size || '0', 10);
          // Instantaneous throughput over the gap since the last tick (~1s), so a
          // bitrate change is visible within a track instead of being smeared into
          // the session average. Guard against the per-reconnect counter reset.
          const dUs = outTimeUs - prevUs;
          const dBytes = totalSize - prevSize;
          if (dUs > 0 && dBytes >= 0) instBitrate = `${((dBytes * 8000) / dUs).toFixed(1)}kbits/s`;
          prevUs = outTimeUs;
          prevSize = totalSize;
          this.progress = {
            timeMs: outTimeUs / 1000,
            outTime: progBuf.out_time || null,
            fps: parseFloat(progBuf.fps || '0'),
            bitrate: progBuf.bitrate || null,
            instBitrate, // recent-window rate (what the UI shows as "live")
            speed: progBuf.speed || null,
            frame: parseInt(progBuf.frame || '0', 10),
            totalSize,
            dropFrames: parseInt(progBuf.drop_frames || '0', 10),
            dupFrames: parseInt(progBuf.dup_frames || '0', 10),
          };
          this.lastStatus = this._statusLine(this.progress);
          this._pushLog('streamer', 'status', this.lastStatus);
          this.emit('progress', { streamId: this.id, playlistId: this.playlistId, ...this.progress, statusLine: this.lastStatus });
          progBuf = {};
        } else {
          progBuf[key] = val;
        }
      }
    });

    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      for (const ln of text.split('\n')) { const t = ln.trim(); if (t) this._pushLog('streamer', 'log', t); }
    });

    proc.on('exit', (code, signal) => {
      this._stopWatchdog(); // don't let it fire during the reconnect gap
      if (this.stopping) return;
      // Unexpected streamer death — the RTMP connection dropped (or the watchdog
      // / rw_timeout killed a hung one).
      const aliveMs = Date.now() - (this.streamerStartedAt || Date.now());
      console.error(`[${this.id}] streamer exited code=${code} sig=${signal} after ${Math.round(aliveMs / 1000)}s\n${stderrTail}`);

      if (!this.autoRestart) {
        // Recovery disabled by the user — end the stream cleanly. Stop the feed
        // loop first so no late feeder exit can respawn one.
        this.stopping = true;
        this.status = 'error';
        this.emit('error', { streamId: this.id, error: `Stream ended: ${stderrTail.split('\n').slice(-3).join(' ')}` });
        this._cleanup();
        return;
      }

      // Auto-restart: reconnect indefinitely with capped exponential backoff.
      // A healthy run resets the counter so transient drops can't accumulate and
      // eventually kill a long-running stream (the old fixed 5-strike cap did).
      if (aliveMs > HEALTHY_RUN_MS) this._reconnects = 0;
      this._reconnects++;
      this.status = 'error';
      this.emit('reconnecting', { streamId: this.id, attempt: this._reconnects });

      // Capture where the current file was so we resume there, then detach the
      // feeder BEFORE killing it: its exit handler (guarded by `this.feeder !==
      // proc`) bows out instead of spawning a feeder — the reconnect timer is
      // the sole owner of the re-feed.
      this._resumeSeek = this.feederKind === 'content'
        ? Math.max(0, this._currentContentOffset() - RESUME_REWIND_S)
        : null;
      const dying = this.feeder;
      this.feeder = null;
      try { dying?.kill('SIGKILL'); } catch {}

      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this._reconnects - 1), RECONNECT_MAX_MS);
      setTimeout(() => {
        if (this.stopping) return;
        this._resetPipe();   // fresh FIFO + zeroed timestamp base for the new session
        this._spawnStreamer();
        this._feedResume();
      }, delay);
    });
  }

  // Stall watchdog: a hung/half-open RTMP link usually freezes the streamer
  // without making it exit (so the exit-based reconnect never fires and the
  // stream is silently "down"). If no -progress tick arrives for STALL_TIMEOUT_MS
  // we force the streamer down; its exit handler then reconnects in place (or, if
  // auto-restart is off, ends the stream cleanly rather than leaving a zombie).
  _startWatchdog() {
    this._stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.stopping || !this.streamer) return;
      const since = Date.now() - (this.lastProgressAt || Date.now());
      if (since > STALL_TIMEOUT_MS) {
        console.error(`[${this.id}] streamer stalled (no progress for ${Math.round(since / 1000)}s) — forcing reconnect`);
        this._stopWatchdog();
        try { this.streamer.kill('SIGKILL'); } catch {}
      }
    }, STALL_CHECK_MS);
    if (this.watchdog.unref) this.watchdog.unref(); // never keep the process alive
  }

  _stopWatchdog() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  _feedNext() {
    if (this.stopping) return;

    let file = null;
    try { file = this.nextFile ? this.nextFile() : null; } catch (e) { file = null; }

    if (file) {
      this._spawnFeeder('content', file);
    } else {
      this._spawnFeeder('slate');
    }
  }

  // Re-feed the CURRENT file at the offset it was last playing (used after a
  // reconnect). Falls back to a normal advance when there's no content to resume.
  _feedResume() {
    if (this.stopping) return;
    if (this._resumeSeek != null && this.currentFile) {
      const seek = this._resumeSeek;
      this._resumeSeek = null;
      this._spawnFeeder('content', this.currentFile, seek);
    } else {
      this._feedNext();
    }
  }

  _spawnFeeder(kind, file = null, seek = null) {
    // Advance the running TS base so the concatenated MPEG-TS the streamer copies
    // stays strictly monotonic across files (each feeder restarts its own output
    // timestamps near zero). We advance by the PREVIOUS feeder's actual emitted
    // duration — read from its -progress out_time, which is 0-based per file —
    // plus exactly one frame. That lands the next file's first frame one frame
    // after the last one: continuous, no gap, no near-colliding/duplicate DTS at
    // the seam (the old wall-clock guess drifted into frame collisions). A
    // wall-clock fallback covers the rare case where no progress tick arrived.
    const now = Date.now();
    if (this.feederStartedAt != null) {
      const frame = 1 / (this.opt.fps || 30);
      const dur = this._feederLastOutSec != null
        ? this._feederLastOutSec
        : Math.max(0, (now - this.feederStartedAt) / 1000);
      this.tsOffset += dur + frame;
    }
    this.feederStartedAt = now;
    this.feederSeek = 0;

    let vf = null;
    let inputArgs;

    if (kind === 'content') {
      // Write the movie name (sans extension) for the bottom-left overlay — or an
      // empty string when the overlay is toggled off (drawtext then draws nothing).
      try { fs.writeFileSync(this.titleFile, this.showTitle ? path.basename(file, path.extname(file)) : ''); } catch {}
      // Resolve this title's chosen subtitle (if any) into a burn-in fragment.
      let subFragment = null;
      try {
        const sub = this.subtitleFor ? this.subtitleFor(file) : null;
        if (sub && sub.safePath && fs.existsSync(sub.safePath)) {
          if (subtitlesFilterAvailable()) {
            subFragment = subtitleFilterFragment(sub.safePath, { fontSize: sub.fontSize });
          } else {
            // libass-less ffmpeg: don't kill the feeder — just note why subs didn't show.
            this._pushLog('feeder', 'log', 'subtitle requested but this ffmpeg lacks the libass `subtitles` filter — skipping burn-in');
          }
        }
      } catch { /* missing/unreadable subtitle just means no overlay */ }
      vf = this._videoFilter(true, subFragment);
      inputArgs = [];
      // Seek: an explicit resume offset wins; otherwise the one-time start
      // offset applies to the very first file only.
      const ss = seek != null ? seek : (this.firstFeed ? this.opt.startTime : null);
      if (ss) { inputArgs.push('-ss', String(ss)); this.feederSeek = parseFloat(ss) || 0; }
      inputArgs.push('-re', '-i', file);
      this.currentFile = file;
      this.status = 'streaming';
      this.emit('nowplaying', { streamId: this.id, playlistId: this.playlistId, file: path.basename(file), path: file });
    } else {
      // Standby slate: solid card + silence, in SLATE_CHUNK_SECONDS bites so we
      // re-check for new content periodically.
      const { width: W, height: H, fps } = this.opt;
      const drawtext = SLATE_FONT
        ? `,drawtext=fontfile='${SLATE_FONT}':text='STANDBY':fontcolor=white:fontsize=${Math.round(H / 16)}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.4:boxborderw=20`
        : '';
      inputArgs = [
        '-re',
        '-f', 'lavfi', '-i', `color=c=0x0a1018:s=${W}x${H}:r=${fps}${drawtext ? `,format=yuv420p${drawtext}` : ''}`,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-t', String(SLATE_CHUNK_SECONDS),
      ];
      this.currentFile = null;
      this.status = 'standby';
      this.emit('standby', { streamId: this.id, playlistId: this.playlistId });
    }
    this.feederKind = kind;

    // Slate already builds its own filtergraph via lavfi; content needs -vf.
    // -progress pipe:1 surfaces the encoder's own status (esp. speed=, which
    // drops below 1x when the box can't encode in realtime) and gives us the
    // feeder's last output PTS for accurate timeline stitching across files.
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', ...inputArgs];
    if (kind === 'content') {
      // Map exactly one real video + one (optional) audio stream and drop
      // everything else. -map 0:V:0 skips attached pictures / cover art that
      // ffmpeg would otherwise auto-pick as "video" and choke the scale filter;
      // -map 0:a:0? takes the first audio track if present; -sn -dn drop
      // subtitle/data streams. This is what keeps oddball mkv files playable.
      args.push('-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', vf);
    }
    args.push(...this._feederOutputArgs());

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.feeder = proc;
    this.firstFeed = false;
    this._feederLastOutSec = null;
    this._pushLog('feeder', 'log', `spawned ${kind}${file ? ' ' + path.basename(file) : ''} @ ts_offset=${this.tsOffset.toFixed(3)}${seek != null ? ` seek=${Number(seek).toFixed(1)}s` : ''}`);

    // Feeder -progress on stdout: track the last output PTS (for stitching) and
    // surface the encoder's status line in the shared log.
    let fProg = {};
    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const i = line.indexOf('=');
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k === 'progress') {
          const us = parseInt(fProg.out_time_us || fProg.out_time_ms || '0', 10);
          if (us > 0) this._feederLastOutSec = us / 1_000_000;
          this._pushLog('feeder', 'status',
            `time=${fProg.out_time || 'N/A'} fps=${fProg.fps || '0'} speed=${fProg.speed || 'N/A'} frame=${fProg.frame || '0'}`);
          fProg = {};
        } else { fProg[k] = v; }
      }
    });

    let errTail = '';
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      errTail = (errTail + text).slice(-1000);
      for (const ln of text.split('\n')) { const t = ln.trim(); if (t) this._pushLog('feeder', 'log', t); }
    });

    proc.on('exit', (code) => {
      if (this.stopping || this.feeder !== proc) return;
      const intentional = this._intentionalSkip;
      this._intentionalSkip = false;
      this.feeder = null;
      if (kind === 'content' && code !== 0 && !intentional) {
        // Bad/corrupt file — log and skip, but keep the stream alive.
        console.error(`[${this.id}] feeder failed for ${file} (code=${code}): ${errTail.trim()}`);
        this.emit('fileskipped', { streamId: this.id, file: file ? path.basename(file) : null });
        this._consecFails++;
      } else {
        this._consecFails = 0; // a clean finish, intentional skip, or slate resets backoff
      }
      // Back off when content fails instantly, so a bad library can't peg the
      // CPU or flood the UI with skip events racing through every file at once.
      const delay = this._consecFails > 0 ? Math.min(250 * this._consecFails, 3000) : 0;
      if (delay) setTimeout(() => this._feedNext(), delay);
      else this._feedNext();
    });
  }

  // Advance to the next file immediately. Killing the active content feeder
  // triggers its exit handler, which feeds the next file — the same path a
  // natural end-of-file takes — so the RTMP connection is never dropped.
  skip() {
    if (this.stopping || this.feederKind !== 'content' || !this.feeder) return false;
    this._intentionalSkip = true;
    try { this.feeder.kill('SIGKILL'); } catch {}
    return true;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.status = 'stopping';
    this._stopWatchdog();

    // Graceful feeder shutdown: SIGINT lets ffmpeg flush buffers and release file
    // handles/threads before we force-kill. SIGKILL'd ffmpegs in a tight cycle
    // leave kernel cleanup pending, which surfaces as spurious "unreadable file"
    // errors on the next start. SIGKILL falls back if the feeder doesn't exit.
    const dyingFeeder = this.feeder;
    if (dyingFeeder) {
      this.feeder = null;
      try { dyingFeeder.kill('SIGINT'); } catch {}
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { dyingFeeder.kill('SIGKILL'); } catch {} resolve(); }, 1500);
        dyingFeeder.on('exit', () => { clearTimeout(t); resolve(); });
      });
    }

    // Closing the held writer fd lets the streamer drain and exit cleanly,
    // which sends a proper RTMP end-of-stream to the platform.
    if (this.holderFd !== null) {
      try { fs.closeSync(this.holderFd); } catch {}
      this.holderFd = null;
    }

    await new Promise((resolve) => {
      if (!this.streamer) return resolve();
      const t = setTimeout(() => { try { this.streamer.kill('SIGKILL'); } catch {} resolve(); }, 4000);
      this.streamer.on('exit', () => { clearTimeout(t); resolve(); });
      try { this.streamer.kill('SIGINT'); } catch {}
    });

    this._cleanup();
    this.status = 'stopped';
    this.emit('stopped', { streamId: this.id, playlistId: this.playlistId });
  }

  // Recreate the FIFO and reset the timestamp base for a clean reconnect: the
  // new RTMP session then starts near zero and reads no leftover bytes from the
  // dropped session, so the platform sees a clean fresh stream rather than a
  // jump to some large timestamp. feederStartedAt is cleared so the first
  // resumed feeder doesn't fold the outage gap into the timestamp base.
  _resetPipe() {
    try { if (this.holderFd !== null) fs.closeSync(this.holderFd); } catch {}
    this.holderFd = null;
    try { fs.unlinkSync(this.fifoPath); } catch {}
    try { execFileSync('mkfifo', [this.fifoPath]); } catch {}
    try { this.holderFd = fs.openSync(this.fifoPath, 'r+'); } catch {}
    this.tsOffset = 0;
    this.feederStartedAt = null;
    this._feederLastOutSec = null;
  }

  _cleanup() {
    this._stopWatchdog();
    try { if (this.holderFd !== null) fs.closeSync(this.holderFd); } catch {}
    this.holderFd = null;
    try { this.feeder?.kill('SIGKILL'); } catch {}
    try { fs.unlinkSync(this.fifoPath); } catch {}
    try { fs.unlinkSync(this.titleFile); } catch {}
  }

  // Live ffmpeg child processes (for resource sampling). Only those still running.
  getProcs() {
    const out = [];
    if (this.streamer && this.streamer.pid && this.streamer.exitCode == null) {
      out.push({ role: 'streamer', pid: this.streamer.pid });
    }
    if (this.feeder && this.feeder.pid && this.feeder.exitCode == null) {
      out.push({ role: this.feederKind === 'slate' ? 'slate' : 'feeder', pid: this.feeder.pid });
    }
    return out;
  }

  getStatus() {
    return {
      id: this.id,
      playlistId: this.playlistId,
      rtmpUrl: this.rtmpUrl,
      status: this.status,
      currentFile: this.currentFile ? path.basename(this.currentFile) : null,
      startTime: this.startedAt,
      progress: this.progress,
      resolution: `${this.opt.width}x${this.opt.height}`,
      videoBitrate: this.opt.videoBitrate,
      audioBitrate: this.opt.audioBitrate,
      autoRestart: this.autoRestart,
      showTitle: this.showTitle,
      lastStatus: this.lastStatus,
      log: this.log.slice(-80),
    };
  }
}
