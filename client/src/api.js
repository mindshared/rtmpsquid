import axios from 'axios';
import { io } from 'socket.io-client';

// Same-origin by default: the server serves this bundle and the API/socket on
// the same host, so this works locally and transparently through an SSH tunnel.
// Override with VITE_API_URL only if you split the deployment.
const BASE = import.meta.env.VITE_API_URL || '';
const TOKEN_KEY = 'rtmpsquid_token';

// Guard every localStorage access: it can throw at import time (private-mode /
// disabled storage / sandboxed iframe), and this module is imported before any
// React ErrorBoundary mounts — an unguarded throw here white-screens the app.
// Degrades gracefully to an in-memory token.
let token = '';
try {
  token = localStorage.getItem(TOKEN_KEY) || '';
} catch {}

export const getToken = () => token;
export const setToken = (t) => {
  token = t || '';
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
};
export const clearToken = () => {
  token = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
};

export const api = axios.create({ baseURL: BASE });

api.interceptors.request.use((cfg) => {
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// Let the app react to an expired/invalid token from anywhere.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) onUnauthorized();
    return Promise.reject(err);
  },
);

// Check a token against the server (used by the login screen).
export async function verifyToken(candidate) {
  try {
    await axios.get(`${BASE}/api/auth/check`, { headers: { Authorization: `Bearer ${candidate}` } });
    return true;
  } catch {
    return false;
  }
}

export function connectSocket() {
  return io(BASE || undefined, { auth: { token }, transports: ['websocket', 'polling'] });
}
