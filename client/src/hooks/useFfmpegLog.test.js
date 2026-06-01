import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFfmpegLog } from './useFfmpegLog';

function makeSocket() {
  const h = {};
  return {
    on: (e, fn) => {
      (h[e] ||= []).push(fn);
    },
    off: (e, fn) => {
      h[e] = (h[e] || []).filter((x) => x !== fn);
    },
    emit: (e, ...a) => (h[e] || []).forEach((fn) => fn(...a)),
  };
}

describe('useFfmpegLog', () => {
  it('seeds from a snapshot, dropping malformed entries', () => {
    const seed = [
      { src: 'streamer', kind: 'status', line: 'frame=1' },
      { src: 'feeder', kind: 'log', line: '' }, // empty line -> dropped
      null, // dropped
      { src: 'streamer', kind: 'status', line: 'frame=2' },
    ];
    const { result } = renderHook(() => useFfmpegLog(makeSocket(), seed));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.lastStatus).toBe('frame=2');
  });

  it('appends valid live entries and ignores malformed ones', () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useFfmpegLog(socket, []));
    act(() => socket.emit('stream:ffmpeg', { src: 'feeder', kind: 'status', line: 'time=1' }));
    act(() => socket.emit('stream:ffmpeg', null));
    act(() => socket.emit('stream:ffmpeg', { line: '' }));
    act(() => socket.emit('stream:ffmpeg', { src: 'streamer', kind: 'status', line: 'bitrate=1500' }));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.lastStatus).toBe('bitrate=1500');
  });

  it('re-seeds (clears the stale tail) when the seed identity changes', () => {
    const socket = makeSocket();
    const seedA = [{ src: 'streamer', kind: 'status', line: 'A' }];
    const { result, rerender } = renderHook(({ s }) => useFfmpegLog(socket, s), { initialProps: { s: seedA } });
    expect(result.current.entries).toHaveLength(1);
    const seedB = [
      { src: 'streamer', kind: 'status', line: 'B1' },
      { src: 'feeder', kind: 'log', line: 'B2' },
    ];
    rerender({ s: seedB });
    expect(result.current.entries.map((e) => e.line)).toEqual(['B1', 'B2']);
    expect(result.current.lastStatus).toBe('B1');
  });

  it('caps the ring at 200 entries', () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useFfmpegLog(socket, []));
    act(() => {
      for (let i = 0; i < 250; i += 1) socket.emit('stream:ffmpeg', { src: 'feeder', kind: 'log', line: `l${i}` });
    });
    expect(result.current.entries.length).toBeLessThanOrEqual(200);
    expect(result.current.entries[result.current.entries.length - 1].line).toBe('l249');
  });
});
