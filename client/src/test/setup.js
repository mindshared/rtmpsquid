import '@testing-library/jest-dom';

// Some jsdom builds don't expose a working Storage (localStorage is undefined for
// opaque origins), which breaks tests that call localStorage.clear()/getItem().
// Provide a minimal in-memory Storage so the app's `ls()` persistence helpers work
// under test. Guarded so a real implementation, when present, is left alone.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.clear !== 'function') {
  class MemStorage {
    #m = new Map();
    get length() {
      return this.#m.size;
    }
    key(i) {
      return [...this.#m.keys()][i] ?? null;
    }
    getItem(k) {
      return this.#m.has(String(k)) ? this.#m.get(String(k)) : null;
    }
    setItem(k, v) {
      this.#m.set(String(k), String(v));
    }
    removeItem(k) {
      this.#m.delete(String(k));
    }
    clear() {
      this.#m.clear();
    }
  }
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, { value: new MemStorage(), configurable: true, writable: true });
  }
}
