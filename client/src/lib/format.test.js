import { describe, it, expect } from 'vitest';
import { basename, niceName, elapsed, liveRate, normalizeBitrate } from './format';

describe('basename', () => {
  it('handles / and \\ separators', () => {
    expect(basename('/a/b/c.mp4')).toBe('c.mp4');
    expect(basename('a\\b\\c.mp4')).toBe('c.mp4');
  });
  it('returns empty string for falsy', () => {
    expect(basename('')).toBe('');
    expect(basename(null)).toBe('');
    expect(basename(undefined)).toBe('');
  });
});

describe('niceName', () => {
  it('strips extension and tidies separators', () => {
    expect(niceName('/x/The.Movie_2020.mkv')).toBe('The Movie 2020');
  });
  it('handles falsy', () => {
    expect(niceName(undefined)).toBe('');
  });
});

describe('elapsed', () => {
  it('formats hh:mm:ss', () => {
    expect(elapsed(0)).toBe('00:00:00');
    expect(elapsed(undefined)).toBe('00:00:00');
    expect(elapsed(3661000)).toBe('01:01:01');
  });
  it('clamps negatives', () => {
    expect(elapsed(-5000)).toBe('00:00:00');
  });
});

describe('liveRate', () => {
  it('normalizes k/m/bare suffixes', () => {
    expect(liveRate('1234.5kbits/s')).toBe('1235k');
    expect(liveRate('2mbits/s')).toBe('2000k');
    expect(liveRate('500bits/s')).toBe('1k');
  });
  it('returns null for N/A or no match', () => {
    expect(liveRate('N/A')).toBeNull();
    expect(liveRate(null)).toBeNull();
    expect(liveRate('garbage')).toBeNull();
  });
});

describe('normalizeBitrate', () => {
  it('keeps values that already carry a unit (k/M/G), normalising the unit', () => {
    expect(normalizeBitrate('1500k')).toBe('1500k');
    expect(normalizeBitrate('3M')).toBe('3M');
    expect(normalizeBitrate('3m')).toBe('3M');
    expect(normalizeBitrate('0.001G')).toBe('1M');
  });
  it('treats a bare small number as Mbps (the bug: "2" must not become 2 bit/s)', () => {
    expect(normalizeBitrate('2')).toBe('2M');
    expect(normalizeBitrate('1.5')).toBe('1.5M');
    expect(normalizeBitrate('6')).toBe('6M');
  });
  it('treats a bare large number as kbps', () => {
    expect(normalizeBitrate('1500')).toBe('1500k');
    expect(normalizeBitrate('3000')).toBe('3000k');
  });
  it('falls back to 3M for empty, junk, or non-positive input', () => {
    expect(normalizeBitrate('')).toBe('3M');
    expect(normalizeBitrate(null)).toBe('3M');
    expect(normalizeBitrate('abc')).toBe('3M');
    expect(normalizeBitrate('0')).toBe('3M');
  });
});
