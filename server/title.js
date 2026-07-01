import path from 'path';

// Turn a media filename into a clean on-screen title for the burned-in overlay.
//
// If the name carries a release year — "2026" or a bracketed "(2026)"/"[2026]" —
// the title ENDS right after that year and everything past it (resolution,
// source, codec, release group, etc.) is dropped. Separators (dots/underscores)
// become spaces so it reads naturally on screen. Names without a year are just
// prettified, not truncated.
//
// Examples:
//   "The Film Name (2026) 1080p BluRay x264-GRP.mkv" -> "The Film Name (2026)"
//   "The.Film.Name.2026.2160p.WEB-DL.mkv"            -> "The Film Name 2026"
//   "2001 A Space Odyssey.mkv"                        -> "2001 A Space Odyssey"
//   "Some.Random.Movie.mkv"                           -> "Some Random Movie"
export function cleanTitle(fileOrName) {
  if (!fileOrName) return '';
  let name = path.basename(String(fileOrName)).replace(/\.[^.]+$/, ''); // drop extension
  const cut = yearCutIndex(name);
  if (cut != null) name = name.slice(0, cut);
  return name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Where to cut the name (exclusive index), just past the release year and its
// closing bracket if it was parenthesised. Returns null when there's no year.
function yearCutIndex(name) {
  // Prefer a bracketed year: (2026) or [2026] — the most reliable release marker.
  const paren = name.match(/[([]\s*(?:19|20)\d{2}\s*[)\]]/);
  if (paren && paren.index > 0) return paren.index + paren[0].length;

  // Otherwise the LAST standalone 4-digit year (19xx/20xx) that isn't part of a
  // longer number and isn't a resolution like 1920x1080. A year at index 0 is
  // treated as part of the title (e.g. "2001 A Space Odyssey"), never a suffix.
  const re = /(?<![\d])(?:19|20)\d{2}(?![\d])(?![x×]\d)/g;
  let m, endIdx = null;
  while ((m = re.exec(name)) !== null) {
    if (m.index === 0) continue;
    endIdx = m.index + m[0].length;
  }
  return endIdx;
}
