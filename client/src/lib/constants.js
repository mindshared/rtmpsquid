// Static UI constants. Kept out of components so they're defined once and easy to
// audit against the server-side encode defaults (server/continuousStream.js).

export const LIB_PAGE = 200; // library rows per page (Prev/Next pages through the rest)

// Advanced-mode encode overrides. Defaults mirror the platform-safe server encode
// (Twitch/Kick/AngelThump). Blank maxrate/bufsize = derived from bitrate.
export const ADV_DEFAULTS = {
  preset: 'veryfast',
  profile: 'high',
  tune: 'zerolatency',
  level: '',
  pixfmt: 'yuv420p',
  gopSeconds: '2',
  bframes: '0',
  sceneCut: '0',
  rateControl: 'cbr',
  crf: '23',
  maxrate: '',
  bufsize: '',
  audioCodec: 'aac',
  audioSampleRate: '48000',
  extraArgs: '',
};

// Option lists for the settings drawer's <datalist>/<select> controls.
export const VIDEO_BITRATES = ['1M', '1.2M', '1.4M', '1.6M', '1.8M', '2M', '3M', '4M', '5M', '6M'];
export const AUDIO_BITRATES = ['64k', '96k', '112k', '128k', '160k', '192k', '256k', '320k'];
export const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
export const PROFILES = ['baseline', 'main', 'high', 'high10', 'none'];
export const TUNES = ['film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency'];
export const PIXFMTS = ['yuv420p', 'yuv422p', 'yuv444p'];
export const ACODECS = ['aac'];
export const ARATES = ['44100', '48000'];
