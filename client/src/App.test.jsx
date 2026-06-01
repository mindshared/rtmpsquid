import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// A fake Socket.IO socket whose registered handlers we can fire by hand, plus a
// mocked ./api so App mounts without a real network/socket. Defined via
// vi.hoisted so the (hoisted) vi.mock factory can reference it.
const { socket, handlers, emit } = vi.hoisted(() => {
  const handlers = {};
  const socket = {
    on: (e, fn) => {
      (handlers[e] ||= []).push(fn);
    },
    off: (e, fn) => {
      handlers[e] = (handlers[e] || []).filter((h) => h !== fn);
    },
    close: () => {},
  };
  const emit = (e, ...args) => {
    (handlers[e] || []).forEach((fn) => fn(...args));
  };
  return { socket, handlers, emit };
});

vi.mock('./api', () => ({
  api: {
    get: vi.fn((url) => {
      if (url === '/api/queue')
        return Promise.resolve({
          data: { streaming: false, paused: false, files: [], libraryCount: 0, currentFile: null },
        });
      if (url === '/api/streams') return Promise.resolve({ data: [] });
      if (url === '/api/library') return Promise.resolve({ data: { folder: null, files: [] } });
      return Promise.resolve({ data: { ok: true } });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
  getToken: () => 'tok',
  clearToken: vi.fn(),
  connectSocket: () => socket,
  setUnauthorizedHandler: vi.fn(),
}));

import App from './App';

beforeEach(() => {
  for (const k in handlers) delete handlers[k];
  localStorage.clear();
});

describe('App socket reducer', () => {
  it('mounts the full tree to the dashboard empty state without crashing', async () => {
    render(<App />);
    expect(await screen.findByText('Point me at your movies')).toBeInTheDocument();
    expect(screen.getByText('🦑 RTMP Squid')).toBeInTheDocument();
  });

  it('ignores a malformed (null) queue:updated payload instead of crashing or blanking', async () => {
    render(<App />);
    await screen.findByText('Point me at your movies');
    await act(async () => {
      emit('queue:updated', null);
    });
    expect(screen.getByText('🦑 RTMP Squid')).toBeInTheDocument();
    expect(screen.getByText('Point me at your movies')).toBeInTheDocument();
  });

  it('renders the queue when a populated queue:updated arrives', async () => {
    render(<App />);
    await screen.findByText('Point me at your movies');
    await act(async () => {
      emit('queue:updated', {
        streaming: false,
        paused: false,
        files: ['/m/a.mp4', '/m/b.mp4'],
        libraryCount: 2,
        currentFile: null,
      });
    });
    expect(await screen.findByText('Up Next')).toBeInTheDocument();
  });

  it('survives stream:progress before any status is fetched (cur === null)', async () => {
    render(<App />);
    await screen.findByText('Point me at your movies');
    await act(async () => {
      emit('stream:progress', { bitrate: '1500.0kbits/s', timeMs: 1000 });
    });
    expect(screen.getByText('🦑 RTMP Squid')).toBeInTheDocument();
  });
});
