import { describe, it, expect } from 'vitest';
import { basename, niceName, elapsed, liveRate, normalizeBitrate, fmtDuration, fmtBytes, parseHMS, formatHMS } from './format';

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

describe('parseHMS', () => {
  it('parses H:MM:SS, M:SS, and bare seconds', () => {
    expect(parseHMS('1:23:45')).toBe(5025);
    expect(parseHMS('4:05')).toBe(245);
    expect(parseHMS('90')).toBe(90);
    expect(parseHMS('0:00:00')).toBe(0);
  });
  it('tolerates whitespace and loose values', () => {
    expect(parseHMS('  2:00  ')).toBe(120);
    expect(parseHMS('1:90')).toBe(150); // 1*60 + 90
    expect(parseHMS('12.5')).toBe(12); // floors fractional seconds
  });
  it('returns null for empty/garbage/too many parts', () => {
    expect(parseHMS('')).toBeNull();
    expect(parseHMS('   ')).toBeNull();
    expect(parseHMS(null)).toBeNull();
    expect(parseHMS('abc')).toBeNull();
    expect(parseHMS('1:2:3:4')).toBeNull();
    expect(parseHMS('1::2')).toBeNull();
  });
});

describe('formatHMS', () => {
  it('renders zero-padded H:MM:SS', () => {
    expect(formatHMS(5025)).toBe('1:23:45');
    expect(formatHMS(245)).toBe('0:04:05');
    expect(formatHMS(0)).toBe('0:00:00');
  });
  it('round-trips with parseHMS', () => {
    for (const s of [0, 5, 65, 3661, 5025, 86399]) expect(parseHMS(formatHMS(s))).toBe(s);
  });
  it('returns empty for invalid', () => {
    expect(formatHMS(-1)).toBe('');
    expect(formatHMS(null)).toBe('');
    expect(formatHMS(NaN)).toBe('');
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

describe('fmtBytes', () => {
  it('formats KB/MB/GB', () => {
    expect(fmtBytes(512 * 1024)).toBe('512 KB');
    expect(fmtBytes(266 * 1024 * 1024)).toBe('266 MB');
    expect(fmtBytes(1.4 * 1024 * 1024 * 1024)).toBe('1.4 GB');
  });
  it('returns empty for invalid', () => {
    expect(fmtBytes(null)).toBe('');
    expect(fmtBytes(-1)).toBe('');
    expect(fmtBytes(undefined)).toBe('');
  });
});

describe('fmtDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(fmtDuration(320)).toBe('5:20');
    expect(fmtDuration(5)).toBe('0:05');
    expect(fmtDuration(3725)).toBe('1:02:05');
  });
  it('returns empty string for unknown/invalid', () => {
    expect(fmtDuration(null)).toBe('');
    expect(fmtDuration(0)).toBe('');
    expect(fmtDuration(undefined)).toBe('');
    expect(fmtDuration(NaN)).toBe('');
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
