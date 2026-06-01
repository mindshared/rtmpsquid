import { describe, it, expect } from 'vitest';
import { basename, niceName, elapsed, liveRate, toM } from './format';

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

describe('toM', () => {
  it('converts k to M and passes through M', () => {
    expect(toM('3000k')).toBe('3M');
    expect(toM('1400k')).toBe('1.4M');
    expect(toM('3M')).toBe('3M');
  });
  it('defaults to 3M for falsy or non-numeric', () => {
    expect(toM('')).toBe('3M');
    expect(toM(null)).toBe('3M');
    expect(toM('abc')).toBe('3M');
  });
});
