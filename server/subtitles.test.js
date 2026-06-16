import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  findSidecarSubtitles,
  subtitleFilterFragment,
  safeTempPathFor,
  clampFontSize,
  SUBTITLE_EXTENSIONS,
} from './subtitles.js';

// Build a throwaway fixture tree and hand back its root so each test is isolated.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtmpsquid-subtest-'));
  const touch = (rel, body = 'x') => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  };
  return { dir, touch, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('findSidecarSubtitles: exact, suffixed, and Subs-folder matches; ignores unrelated', () => {
  const { dir, touch, cleanup } = fixture();
  try {
    const movie = touch('Movie.mkv');
    touch('Movie.srt');
    touch('Movie.en.srt');
    touch('Movie.forced.eng.ass');
    touch('OtherFilm.srt'); // different movie — must NOT match
    touch('Movie.txt'); // not a subtitle extension
    touch('Subs/English.srt'); // nearby Subs folder
    touch('Subs/Spanish.vtt');

    const found = findSidecarSubtitles(movie);
    const sources = found.map((f) => f.source).sort();

    assert.deepEqual(sources, [
      'Movie.en.srt',
      'Movie.forced.eng.ass',
      'Movie.srt',
      'Subs/English.srt',
      'Subs/Spanish.vtt',
    ]);
    // Every result is an absolute, existing file flagged as kind 'file'.
    for (const f of found) {
      assert.equal(f.kind, 'file');
      assert.ok(path.isAbsolute(f.path) && fs.existsSync(f.path));
      assert.ok(typeof f.label === 'string' && f.label.length > 0);
    }
    // The suffix becomes a human label.
    const en = found.find((f) => f.source === 'Movie.en.srt');
    assert.equal(en.label, 'en');
  } finally {
    cleanup();
  }
});

test('findSidecarSubtitles: returns [] for a missing directory without throwing', () => {
  const found = findSidecarSubtitles('/no/such/place/Movie.mkv');
  assert.deepEqual(found, []);
});

test('safeTempPathFor: stable, hashed, filtergraph-safe basename keeping the extension', () => {
  const a = safeTempPathFor('/movies/Weird: Name, [2024]/sub.srt');
  const b = safeTempPathFor('/movies/Weird: Name, [2024]/sub.srt');
  assert.equal(a, b); // deterministic
  assert.ok(a.endsWith('.srt'));
  const base = path.basename(a);
  // No character the ffmpeg filtergraph parser treats specially.
  assert.ok(!/[:,'[\]]/.test(base), `unsafe basename: ${base}`);
  // .ass keeps its extension so libass picks the right demuxer.
  assert.ok(safeTempPathFor('/x/y.ass').endsWith('.ass'));
});

test('subtitleFilterFragment: well-formed, quotes the path, honours font size', () => {
  const frag = subtitleFilterFragment('/tmp/rtmpsquid-sub-abc.srt', { fontSize: 28 });
  assert.match(frag, /^subtitles=filename='\/tmp\/rtmpsquid-sub-abc\.srt':force_style='[^']*'$/);
  assert.match(frag, /FontSize=28/);
  // Defaults to a sane size when none is given.
  assert.match(subtitleFilterFragment('/tmp/s.srt'), /FontSize=20/);
});

test('clampFontSize: clamps to [8,96] and falls back on junk', () => {
  assert.equal(clampFontSize(28), 28);
  assert.equal(clampFontSize(2), 8);
  assert.equal(clampFontSize(500), 96);
  assert.equal(clampFontSize('nope', 20), 20);
});

test('SUBTITLE_EXTENSIONS covers the common text formats', () => {
  for (const ext of ['.srt', '.ass', '.ssa', '.vtt', '.sub']) {
    assert.ok(SUBTITLE_EXTENSIONS.includes(ext));
  }
});
