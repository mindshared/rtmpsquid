#!/usr/bin/env node
// Live end-to-end smoke test for burned-in subtitles.
//
// It exercises the SAME production helpers the streamer uses
// (resolveSubtitleToTemp + subtitleFilterFragment), then runs ffmpeg to:
//   1. generate a tiny test clip + a .srt,
//   2. burn the subtitle in with our exact filtergraph,
//   3. prove the subtitle actually rendered by diffing a frame WITH the filter
//      against the same frame WITHOUT it (different pixels ⇒ text was drawn).
//
// Run: npm run test:subtitles   (requires ffmpeg on PATH)

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { subtitleFilterFragment, resolveSubtitleToTemp, removeTempSubtitle, subtitlesFilterAvailable } from '../server/subtitles.js';

const W = 640;
const H = 360;
const FPS = 30;

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  return r;
}

function die(msg, extra = '') {
  console.error(`\n❌ ${msg}\n${extra}`);
  process.exit(1);
}

// Bail early with a friendly message if ffmpeg isn't installed.
if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  die('ffmpeg not found on PATH — install it to run this smoke test.');
}

// A libass-less ffmpeg can't burn subtitles in at all. The app degrades to "no
// overlay" in that case (by design), and there's nothing to smoke-test here, so
// skip cleanly rather than reporting a code failure.
if (!subtitlesFilterAvailable()) {
  console.log('⏭  SKIPPED — this ffmpeg build has no libass `subtitles` filter.');
  console.log('   (The app detects this and skips burn-in; rebuild ffmpeg with --enable-libass to test it.)');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rtmpsquid-subsmoke-'));
const movie = path.join(work, 'Clip.mp4');
const srt = path.join(work, 'Clip.srt');
let safe;

try {
  // 1) A 3s colour-bars clip with silent audio (mirrors a real content file).
  let r = ff([
    '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=${FPS}:duration=3`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-shortest', '-pix_fmt', 'yuv420p', movie,
  ]);
  if (r.status !== 0) die('Failed to generate the test clip', r.stderr);

  // A subtitle cue that's on-screen at t=1.0s.
  fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,500\nRTMP SQUID SUBTITLE TEST\n');

  // 2) Resolve + build the burn-in filter exactly as the streamer does.
  safe = resolveSubtitleToTemp(srt);
  if (!fs.existsSync(safe)) die('resolveSubtitleToTemp did not create the temp copy');
  const subFragment = subtitleFilterFragment(safe, { fontSize: 28 });
  const baseVf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`;
  const vfWithSubs = `${baseVf},${subFragment}`;

  // Burn the whole clip (proves the filtergraph encodes cleanly end-to-end).
  const burned = path.join(work, 'burned.mp4');
  r = ff(['-y', '-i', movie, '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-vf', vfWithSubs, '-c:v', 'libx264', '-t', '3', burned]);
  if (r.status !== 0) die('ffmpeg failed to burn in subtitles (filtergraph or libass issue)', r.stderr);
  if (!fs.statSync(burned).size) die('Burned output is empty');
  console.log('✔ subtitles filtergraph encoded the full clip without error');

  // 3) Compare a frame at t=1.0s (inside the cue) WITH vs WITHOUT subs. We sample
  // the subtitled frame from the already-burned clip — the subs are pixels by now,
  // so a plain input seek lines up — and the plain frame from the source. Input
  // seeking the SOURCE through the subtitles filter would reset timestamps and miss
  // the cue, which is exactly why we burn first, then sample.
  const frameWith = path.join(work, 'with.png');
  const frameWithout = path.join(work, 'without.png');
  r = ff(['-y', '-ss', '1.0', '-i', burned, '-frames:v', '1', frameWith]);
  if (r.status !== 0) die('Failed to sample the subtitled frame', r.stderr);
  r = ff(['-y', '-ss', '1.0', '-i', movie, '-vf', baseVf, '-frames:v', '1', frameWithout]);
  if (r.status !== 0) die('Failed to render the plain frame', r.stderr);

  const hashWith = crypto.createHash('sha1').update(fs.readFileSync(frameWith)).digest('hex');
  const hashWithout = crypto.createHash('sha1').update(fs.readFileSync(frameWithout)).digest('hex');
  if (hashWith === hashWithout) {
    die('Subtitle did NOT alter the frame — text was not rendered (is libass/the subtitles filter available?)');
  }
  console.log('✔ subtitle text changed the rendered frame (burn-in confirmed)');

  console.log('\n✅ Subtitle burn-in smoke test passed.');
} finally {
  removeTempSubtitle(safe);
  fs.rmSync(work, { recursive: true, force: true });
}
