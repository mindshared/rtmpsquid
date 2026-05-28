import { spawn, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

// Locate a usable font for the standby slate's text (optional — we fall back
// to a plain colour card if none is found).
const SLATE_FONT = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
].find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;

const SLATE_CHUNK_SECONDS = 8; // how long each slate segment runs before re-checking for content

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
  constructor({ id, rtmpUrl, options = {}, nextFile, playlistId = null }) {
    super();
    this.id = id || crypto.randomUUID();
    this.rtmpUrl = rtmpUrl;
    this.playlistId = playlistId;
    this.nextFile = nextFile; // () => string | null  (next file path, or null for standby)

    const [w, h] = (options.resolution || '1920x1080').split('x').map(n => parseInt(n, 10));
    this.opt = {
      width: w || 1920,
      height: h || 1080,
      fps: parseInt(options.fps, 10) || 30,
      videoBitrate: options.bitrate || '3000k',
      audioBitrate: options.audioBitrate || '160k',
      audioChannels: parseInt(options.audioChannels, 10) || 2,
      // 'fit' = letterbox/pillarbox with bars; 'stretch' = distort to fill;
      // 'crop' = zoom to fill then crop overflow. forceStretch kept for back-compat.
      fit: options.fit || (options.forceStretch ? 'stretch' : 'fit'),
      startTime: options.startTime || null,
    };

    // Advanced-mode encode overrides (or platform-safe defaults when absent).
    this.enc = normalizeEncode(options.advanced);

    this.fifoPath = path.join(config.tmpDir, `rtmpsquid-${this.id}.ts`);
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
    this.restarts = 0;
    this.maxRestarts = 5;
    this._intentionalSkip = false; // set when the user hits Next, so the early
                                   // feeder exit isn't logged as an unreadable skip
    this._consecFails = 0;         // consecutive instant feeder failures (for backoff)
  }

  // ---- ffmpeg argument builders -------------------------------------------

  _videoFilter() {
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
    return `${scale},setsar=1,fps=${fps},format=yuv420p`;
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

    return [...v, ...a, ...parseArgString(e.extraArgs), '-f', 'mpegts', this.fifoPath];
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
      '-f', 'flv',
      '-progress', 'pipe:1', '-nostats',
      this.rtmpUrl,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.streamer = proc;

    let progBuf = {};
    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (key === 'progress') {
          this.progress = {
            timeMs: parseInt(progBuf.out_time_us || progBuf.out_time_ms || '0', 10) / 1000,
            fps: parseFloat(progBuf.fps || '0'),
            bitrate: progBuf.bitrate,
            frame: parseInt(progBuf.frame || '0', 10),
          };
          this.emit('progress', { streamId: this.id, playlistId: this.playlistId, ...this.progress });
          progBuf = {};
        } else {
          progBuf[key] = val;
        }
      }
    });

    let stderrTail = '';
    proc.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

    proc.on('exit', (code, signal) => {
      if (this.stopping) return;
      // Unexpected streamer death — the RTMP connection dropped. Try to recover.
      console.error(`[${this.id}] streamer exited code=${code} sig=${signal}\n${stderrTail}`);
      if (this.restarts < this.maxRestarts) {
        this.restarts++;
        this.status = 'error';
        this.emit('reconnecting', { streamId: this.id, attempt: this.restarts });
        // Detach the feeder BEFORE killing it so its exit handler (guarded by
        // `this.feeder !== proc`) bows out instead of spawning a second feeder
        // into the FIFO — the reconnect timer is the sole owner of the re-feed.
        const dying = this.feeder;
        this.feeder = null;
        try { dying?.kill('SIGKILL'); } catch {}
        setTimeout(() => {
          if (this.stopping) return;
          this._spawnStreamer();
          this._feedNext();
        }, 2000);
      } else {
        // Out of retries: stop the feed loop for good before cleanup so no
        // orphaned/late feeder exit can respawn another one.
        this.stopping = true;
        this.status = 'error';
        this.emit('error', { streamId: this.id, error: `Streamer failed: ${stderrTail.split('\n').slice(-3).join(' ')}` });
        this._cleanup();
      }
    });
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

  _spawnFeeder(kind, file = null) {
    const vf = this._videoFilter();
    let inputArgs;

    if (kind === 'content') {
      inputArgs = [];
      // Apply an optional seek to the first file only.
      if (this.firstFeed && this.opt.startTime) inputArgs.push('-ss', String(this.opt.startTime));
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
    const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs];
    if (kind === 'content') {
      // Map exactly one real video + one (optional) audio stream and drop
      // everything else. -map 0:V:0 skips attached pictures / cover art that
      // ffmpeg would otherwise auto-pick as "video" and choke the scale filter;
      // -map 0:a:0? takes the first audio track if present; -sn -dn drop
      // subtitle/data streams. This is what keeps oddball mkv files playable.
      args.push('-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', vf);
    }
    args.push(...this._feederOutputArgs());

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.feeder = proc;
    this.firstFeed = false;

    let errTail = '';
    proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-1000); });

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

  _cleanup() {
    try { if (this.holderFd !== null) fs.closeSync(this.holderFd); } catch {}
    this.holderFd = null;
    try { this.feeder?.kill('SIGKILL'); } catch {}
    try { fs.unlinkSync(this.fifoPath); } catch {}
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
    };
  }
}
