import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from './config.js';

// Constant-time token comparison to avoid timing oracles.
function tokensMatch(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.authToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (typeof req.query.token === 'string') return req.query.token;
  return '';
}

// Express middleware: reject any request without a valid bearer token.
export function requireAuth(req, res, next) {
  if (tokensMatch(extractToken(req))) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// socket.io middleware: same check on the handshake.
export function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (tokensMatch(token)) return next();
  return next(new Error('Unauthorized'));
}

/**
 * Resolve a user-supplied path and guarantee it stays inside the media root.
 * Returns the real, absolute path, or throws if it escapes the root (covers
 * `..` traversal and symlinks that point outside the tree).
 */
export function resolveWithinRoot(userPath, { mustExist = true, realpath = true } = {}) {
  if (!userPath || typeof userPath !== 'string') {
    const err = new Error('Path is required');
    err.status = 400;
    throw err;
  }

  const root = config.mediaRoot;
  // Resolve relative paths against the media root, absolute ones as-is.
  const candidate = path.resolve(root, userPath);

  // Realpath collapses symlinks so we can verify the *physical* location.
  let real = candidate;
  if (fs.existsSync(candidate)) {
    real = fs.realpathSync(candidate);
  } else if (mustExist) {
    const err = new Error('Path not found');
    err.status = 404;
    throw err;
  }

  const realRoot = fs.realpathSync(root);
  const rel = path.relative(realRoot, real);
  const inside = real === realRoot || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!inside) {
    const err = new Error('Access denied: path is outside the media directory');
    err.status = 403;
    throw err;
  }
  // Confinement is always verified against the physical (realpath) location, but
  // callers that key data by the same path the library/queue uses want the
  // logical (symlinks-intact) path back — the queue is built from path.join, not
  // realpath, so a realpath'd key wouldn't match. realpath:false returns that.
  return realpath ? real : candidate;
}

// Validate that a stream target is an RTMP(S) URL and nothing else (no file:,
// http:, pipe:, etc. — which ffmpeg would otherwise happily write to).
export function assertSafeStreamUrl(rtmpUrl) {
  let parsed;
  try {
    parsed = new URL(rtmpUrl);
  } catch {
    const err = new Error('Invalid RTMP URL');
    err.status = 400;
    throw err;
  }
  if (!config.allowedStreamProtocols.includes(parsed.protocol)) {
    const err = new Error(`Only ${config.allowedStreamProtocols.join('/')} stream targets are allowed`);
    err.status = 400;
    throw err;
  }
  return rtmpUrl;
}
