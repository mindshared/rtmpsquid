import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle } from './title.js';

test('ends the title at a bracketed year and drops the rest', () => {
  assert.equal(cleanTitle('The Film Name (2026) 1080p BluRay x264-GRP.mkv'), 'The Film Name (2026)');
  assert.equal(cleanTitle('/movies/Another.One.[2019].2160p.WEB-DL.mkv'), 'Another One [2019]');
});

test('ends the title at a bare (dot-separated) year', () => {
  assert.equal(cleanTitle('The.Film.Name.2026.2160p.WEB-DL.DDP5.1-GRP.mkv'), 'The Film Name 2026');
  assert.equal(cleanTitle('Some Movie 1999 720p.mp4'), 'Some Movie 1999');
});

test('keeps a leading year (part of the title, not a suffix)', () => {
  assert.equal(cleanTitle('2001 A Space Odyssey.mkv'), '2001 A Space Odyssey');
  assert.equal(cleanTitle('2012.mkv'), '2012');
});

test('prefers the real (later) release year when the title also contains a year', () => {
  assert.equal(cleanTitle('Blade Runner 2049 (2017) 1080p.mkv'), 'Blade Runner 2049 (2017)');
  assert.equal(cleanTitle('2001 A Space Odyssey 1968 1080p.mkv'), '2001 A Space Odyssey 1968');
});

test('does not mistake a resolution for a year', () => {
  assert.equal(cleanTitle('Cool.Movie.1920x1080.mkv'), 'Cool Movie 1920x1080');
});

test('no year: just prettifies separators, no truncation', () => {
  assert.equal(cleanTitle('Some.Random_Movie.mkv'), 'Some Random Movie');
  assert.equal(cleanTitle('Plain Name.mp4'), 'Plain Name');
});

test('empty / falsy input is safe', () => {
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
  assert.equal(cleanTitle(undefined), '');
});
