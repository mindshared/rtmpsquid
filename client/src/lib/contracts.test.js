import { describe, it, expect } from 'vitest';
import { normalizeQueue, normalizeLibrary, normalizeStatus, normalizeLogEntry } from './contracts';

describe('normalizeQueue', () => {
  it('returns null for non-objects', () => {
    expect(normalizeQueue(null)).toBeNull();
    expect(normalizeQueue(undefined)).toBeNull();
    expect(normalizeQueue('<html>')).toBeNull();
    expect(normalizeQueue(42)).toBeNull();
  });
  it('coerces partial payloads to safe shapes', () => {
    const q = normalizeQueue({ files: undefined, streaming: 1, paused: 0, libraryCount: '7' });
    expect(q.files).toEqual([]);
    expect(q.streaming).toBe(true);
    expect(q.paused).toBe(false);
    expect(q.libraryCount).toBe(7);
    expect(q.currentFile).toBeNull();
  });
  it('preserves well-formed fields verbatim', () => {
    const raw = {
      library: '/m',
      libraryCount: 3,
      files: ['a', 'b'],
      currentFile: 'a',
      streaming: true,
      streamId: 'x',
      rtmpUrl: 'rtmp://h',
      paused: false,
      autoRestart: true,
      resumeOffset: 5,
    };
    expect(normalizeQueue(raw)).toMatchObject(raw);
  });
});

describe('normalizeLibrary', () => {
  it('always returns folder+files+durations+excluded', () => {
    expect(normalizeLibrary(null)).toEqual({ folder: null, files: [], durations: {}, excluded: [] });
    expect(normalizeLibrary({ folder: 'x' })).toEqual({ folder: 'x', files: [], durations: {}, excluded: [] });
    expect(normalizeLibrary({ files: 'oops' })).toEqual({ folder: null, files: [], durations: {}, excluded: [] });
  });
  it('preserves minMovieMB, durations and excluded when present', () => {
    expect(
      normalizeLibrary({ folder: 'x', files: ['a', 'b'], minMovieMB: 5, durations: { a: 12 }, excluded: ['b'] }),
    ).toEqual({
      folder: 'x',
      files: ['a', 'b'],
      durations: { a: 12 },
      excluded: ['b'],
      minMovieMB: 5,
    });
  });
  it('coerces a non-array excluded to []', () => {
    expect(normalizeLibrary({ folder: 'x', excluded: 'nope' }).excluded).toEqual([]);
  });
});

describe('normalizeStatus', () => {
  it('returns null for non-objects', () => {
    expect(normalizeStatus(null)).toBeNull();
    expect(normalizeStatus(undefined)).toBeNull();
  });
  it('guarantees a log array', () => {
    expect(normalizeStatus({ status: 'streaming' }).log).toEqual([]);
    expect(normalizeStatus({ log: [{ src: 'streamer', kind: 'status', line: 'x' }] }).log).toHaveLength(1);
  });
});

describe('normalizeLogEntry', () => {
  it('rejects malformed entries', () => {
    expect(normalizeLogEntry(null)).toBeNull();
    expect(normalizeLogEntry({})).toBeNull();
    expect(normalizeLogEntry({ src: 'streamer', kind: 'status', line: '' })).toBeNull();
    expect(normalizeLogEntry({ line: 5 })).toBeNull();
  });
  it('passes through valid entries', () => {
    const e = { src: 'feeder', kind: 'log', line: 'hello' };
    expect(normalizeLogEntry(e)).toBe(e);
  });
});
