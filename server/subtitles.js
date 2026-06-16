import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { config } from './config.js';

// The `subtitles` burn-in filter needs an ffmpeg built with libass. Some minimal
// builds omit it, so probe once (cached) — callers skip the overlay rather than
// letting every feeder die with "No such filter: 'subtitles'".
let _hasSubFilter = null;
export function subtitlesFilterAvailable() {
  if (_hasSubFilter === null) {
    try {
      const out = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      _hasSubFilter = /\bsubtitles\b/.test(out);
    } catch {
      _hasSubFilter = false;
    }
  }
  return _hasSubFilter;
}

// Text subtitle formats we recognise as sidecar files. These are the ones libass
// (the `subtitles` filter) can render directly when burned into the video. Bitmap
// subs (PGS/VobSub) need a different pipeline and are intentionally out of scope.
export const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt', '.sub'];

const isSubName = (name) => SUBTITLE_EXTENSIONS.includes(path.extname(name).toLowerCase());

// Derive a short human label from the part of a subtitle filename that follows the
// video's base name, e.g. "Movie.en.forced.srt" next to "Movie.mkv" -> "en forced".
// Falls back to the bare name (sans extension) when there's no shared prefix.
function labelFromSidecar(videoBase, subName) {
  const subBase = subName.replace(/\.[^.]+$/, '');
  const lower = subBase.toLowerCase();
  const vlower = videoBase.toLowerCase();
  let extra = lower.startsWith(vlower) ? subBase.slice(videoBase.length) : subBase;
  extra = extra.replace(/^[._\- ]+/, '').replace(/[._]/g, ' ').trim();
  return extra || 'Subtitles';
}

/**
 * Find subtitle files associated with a video by convention:
 *   1. Files in the SAME folder whose name matches the video's base name
 *      (Movie.srt, Movie.en.srt, "Movie eng.srt").
 *   2. Any subtitle files inside a sibling "Subs"/"Subtitles" folder.
 * Returns [{ kind:'file', path, label, source }]. Never throws — an unreadable
 * directory simply yields fewer (or no) results. The picker also lets the user
 * browse for a file anywhere under the media root, so this is best-effort.
 */
export function findSidecarSubtitles(videoPath) {
  const dir = path.dirname(videoPath);
  const videoBase = path.basename(videoPath, path.extname(videoPath));
  const vlower = videoBase.toLowerCase();
  const out = [];
  const seen = new Set();

  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  // 1) same-folder sidecars sharing the video's base name
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink() || !isSubName(e.name)) continue;
    const base = e.name.replace(/\.[^.]+$/, '').toLowerCase();
    const matches = base === vlower || base.startsWith(`${vlower}.`) || base.startsWith(`${vlower} `);
    if (!matches) continue;
    const full = path.join(dir, e.name);
    if (seen.has(full)) continue;
    seen.add(full);
    out.push({ kind: 'file', path: full, label: labelFromSidecar(videoBase, e.name), source: e.name });
  }

  // 2) subtitle files inside a nearby Subs/Subtitles folder (one level down)
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || !/^(subs?|subtitles)$/i.test(e.name)) continue;
    const subDir = path.join(dir, e.name);
    let subEntries = [];
    try { subEntries = fs.readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
    for (const se of subEntries) {
      if (!se.isFile() || se.isSymbolicLink() || !isSubName(se.name)) continue;
      const full = path.join(subDir, se.name);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ kind: 'file', path: full, label: `${e.name}/${se.name.replace(/\.[^.]+$/, '')}`, source: `${e.name}/${se.name}` });
    }
  }

  return out;
}

// A collision-free, filtergraph-safe temp path for a subtitle. The basename is a
// hash so it can never contain a character the ffmpeg filtergraph parser treats
// specially (`:`, `,`, `'`, `[`), sidestepping the notorious subtitles= path
// escaping entirely. The original extension is kept so libass picks the right
// demuxer (.srt vs .ass vs .vtt).
export function safeTempPathFor(subPath) {
  const ext = path.extname(subPath).toLowerCase() || '.srt';
  const hash = crypto.createHash('sha1').update(String(subPath)).digest('hex').slice(0, 16);
  return path.join(config.tmpDir, `rtmpsquid-sub-${hash}${ext}`);
}

// Copy a chosen subtitle to its safe temp path so the burn-in filter always
// references a clean ASCII path. Returns the temp path. Throws if the source
// can't be read (caller surfaces it).
export function resolveSubtitleToTemp(subPath) {
  const dest = safeTempPathFor(subPath);
  fs.copyFileSync(subPath, dest);
  return dest;
}

// Best-effort removal of a temp subtitle copy.
export function removeTempSubtitle(tempPath) {
  if (!tempPath) return;
  try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
}

// Build the `subtitles` filter fragment that burns a subtitle file into the video.
// `safePath` is the hashed temp copy (see resolveSubtitleToTemp), wrapped in single
// quotes so spaces in a custom tmp dir are tolerated. force_style sets the size and
// a readable outline. Font size is a plain ASS FontSize the user tunes live.
export function subtitleFilterFragment(safePath, { fontSize } = {}) {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? Math.round(fontSize) : 20;
  const style = `FontSize=${size},Outline=2,Shadow=0,OutlineColour=&H90000000&,BorderStyle=1`;
  return `subtitles=filename='${safePath}':force_style='${style}'`;
}

// Clamp a requested global subtitle font size to a sane on-screen range.
export function clampFontSize(v, fallback = 20) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(96, Math.max(8, Math.round(n)));
}
