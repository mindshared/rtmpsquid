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
      forceStretch: options.forceStretch ?? false,
      startTime: options.startTime || null,
    };

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
  }

  // ---- ffmpeg argument builders -------------------------------------------

  _videoFilter() {
    const { width: W, height: H, fps, forceStretch } = this.opt;
    const scale = forceStretch
      ? `scale=${W}:${H}:force_original_aspect_ratio=ignore`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
    return `${scale},setsar=1,fps=${fps},format=yuv420p`;
  }

  // Output options shared by every feeder. -bf 0 keeps DTS == PTS so the
  // concatenated TS the streamer copies stays monotonic across file boundaries.
  _feederOutputArgs() {
    const { fps, videoBitrate, audioBitrate, audioChannels } = this.opt;
    const gop = fps * 2;
    const bufsize = `${parseInt(videoBitrate, 10) * 2}k`;
    return [
      '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0',
      '-b:v', videoBitrate, '-maxrate', videoBitrate, '-bufsize', bufsize,
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', audioBitrate, '-ar', '44100', '-ac', String(audioChannels),
      '-f', 'mpegts', this.fifoPath,
    ];
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
        try { this.feeder?.kill('SIGKILL'); } catch {}
        setTimeout(() => {
          if (this.stopping) return;
          this._spawnStreamer();
          this._feedNext();
        }, 2000);
      } else {
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
        ? `,drawtext=fontfile='${SLATE_FONT}':text='RTMP SQUID — STANDBY':fontcolor=white:fontsize=${Math.round(H / 16)}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.4:boxborderw=20`
        : '';
      inputArgs = [
        '-re',
        '-f', 'lavfi', '-i', `color=c=0x0a1018:s=${W}x${H}:r=${fps}${drawtext ? `,format=yuv420p${drawtext}` : ''}`,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t', String(SLATE_CHUNK_SECONDS),
      ];
      this.currentFile = null;
      this.status = 'standby';
      this.emit('standby', { streamId: this.id, playlistId: this.playlistId });
    }
    this.feederKind = kind;

    // Slate already builds its own filtergraph via lavfi; content needs -vf.
    const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs];
    if (kind === 'content') args.push('-vf', vf);
    args.push(...this._feederOutputArgs());

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.feeder = proc;
    this.firstFeed = false;

    let errTail = '';
    proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-1000); });

    proc.on('exit', (code) => {
      if (this.stopping || this.feeder !== proc) return;
      if (kind === 'content' && code !== 0) {
        // Bad/corrupt file — log and skip, but keep the stream alive.
        console.error(`[${this.id}] feeder failed for ${file} (code=${code}): ${errTail.trim()}`);
        this.emit('fileskipped', { streamId: this.id, file: file ? path.basename(file) : null });
      }
      this.feeder = null;
      this._feedNext();
    });
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.status = 'stopping';

    try { this.feeder?.kill('SIGKILL'); } catch {}

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
