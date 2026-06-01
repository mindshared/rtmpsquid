// @ts-check
// Single source of truth for the server↔client data shapes, plus defensive
// normalizers applied at every data boundary (socket payloads + REST responses).
// The normalizers are behavior-preserving for well-formed data — they only add
// fallbacks so a malformed/partial payload can never throw downstream or blank
// the UI. Shapes mirror server/streamManager.js getQueue() and
// server/continuousStream.js getStatus().

/**
 * @typedef {Object} QueueState
 * @property {string|null} library
 * @property {number} libraryCount
 * @property {string[]} files
 * @property {string|null} currentFile
 * @property {boolean} streaming
 * @property {string|null} streamId
 * @property {string|null} rtmpUrl
 * @property {number} [minMovieMB]
 * @property {boolean} paused
 * @property {boolean} [canResume]
 * @property {string|null} [resumeFile]
 * @property {number|null} [resumeOffset]
 * @property {boolean} [autoRestart]
 * @property {Object<string, number>} [durations] map of queued path -> seconds
 * @property {number} [totalSeconds] sum of known queued durations
 * @property {boolean} [totalKnown] false while some queued durations are still probing
 */

/**
 * @typedef {Object} Library
 * @property {string|null} folder
 * @property {string[]} files
 * @property {number} [minMovieMB]
 * @property {Object<string, number>} [durations] map of library path -> seconds
 */

/**
 * @typedef {Object} StreamProgress
 * @property {number} [timeMs]
 * @property {string} [bitrate]
 * @property {string} [instBitrate]
 * @property {string} [speed]
 * @property {number} [fps]
 * @property {number} [frame]
 */

/**
 * @typedef {Object} StreamStatus
 * @property {string} [id]
 * @property {string|null} [playlistId]
 * @property {string|null} [rtmpUrl]
 * @property {string} [status]
 * @property {string|null} [currentFile]
 * @property {number|null} [startTime]
 * @property {StreamProgress} [progress]
 * @property {string} [resolution]
 * @property {string} [videoBitrate]
 * @property {string} [audioBitrate]
 * @property {boolean} [autoRestart]
 * @property {string|null} [lastStatus]
 * @property {FfmpegLogEntry[]} log
 */

/**
 * @typedef {Object} FfmpegLogEntry
 * @property {number} [t]
 * @property {string} src
 * @property {string} kind
 * @property {string} line
 */

/** @param {any} v @returns {any[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {any} v @returns {boolean} */
const isObj = (v) => !!v && typeof v === 'object';

/**
 * Coerce an unknown payload into a QueueState. Returns null for non-objects so
 * callers can bail without replacing good state with garbage.
 * @param {any} raw
 * @returns {QueueState|null}
 */
export const normalizeQueue = (raw) =>
  isObj(raw)
    ? {
        ...raw,
        library: raw.library ?? null,
        libraryCount: Number(raw.libraryCount) || 0,
        files: arr(raw.files),
        currentFile: raw.currentFile ?? null,
        streaming: !!raw.streaming,
        streamId: raw.streamId ?? null,
        rtmpUrl: raw.rtmpUrl ?? null,
        paused: !!raw.paused,
      }
    : null;

/**
 * Coerce an unknown payload into a Library (always returns a usable object).
 * @param {any} raw
 * @returns {Library}
 */
export const normalizeLibrary = (raw) => ({
  folder: isObj(raw) ? (raw.folder ?? null) : null,
  files: arr(isObj(raw) ? raw.files : null),
  durations: isObj(raw) && isObj(raw.durations) ? raw.durations : {},
  ...(isObj(raw) && raw.minMovieMB != null ? { minMovieMB: raw.minMovieMB } : {}),
});

/**
 * Coerce an unknown /api/streams[0] payload into a StreamStatus, guaranteeing a
 * `log` array. Returns null for non-objects (no active stream).
 * @param {any} raw
 * @returns {StreamStatus|null}
 */
export const normalizeStatus = (raw) => (isObj(raw) ? { ...raw, log: arr(raw.log) } : null);

/**
 * Validate a single ffmpeg log entry; returns null if it isn't a usable line.
 * @param {any} e
 * @returns {FfmpegLogEntry|null}
 */
export const normalizeLogEntry = (e) =>
  isObj(e) && typeof e.src === 'string' && typeof e.kind === 'string' && typeof e.line === 'string' && e.line
    ? e
    : null;
