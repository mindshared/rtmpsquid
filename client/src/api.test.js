import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api.js reads localStorage at import time; verify a throwing/blocked storage
// (private mode, sandboxed iframe) degrades to an in-memory token instead of a
// throw that would white-screen the app before any ErrorBoundary mounts (R5).
describe('api token storage resilience', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('does not throw at import when localStorage.getItem throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const mod = await import('./api');
    expect(mod.getToken()).toBe('');
  });

  it('setToken/clearToken swallow storage errors and keep the in-memory token correct', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const mod = await import('./api');
    expect(() => mod.setToken('abc')).not.toThrow();
    expect(mod.getToken()).toBe('abc');
    expect(() => mod.clearToken()).not.toThrow();
    expect(mod.getToken()).toBe('');
  });
});
