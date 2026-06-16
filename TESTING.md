# Testing — mobile reorder & per-title subtitles

How to verify the two features added here: **drag-to-reorder the queue on mobile**
and **per-title burned-in subtitles**.

## Automated

```bash
npm test            # server unit tests (node --test): subtitle discovery, temp-path
                    # safety, filter fragment, font-size clamping
npm run test:client # client unit tests (vitest), incl. the pointer hit-test math
npm run test:subtitles  # live ffmpeg burn-in smoke test (see note below)
```

### `npm run test:subtitles`

Generates a 3s clip + a `.srt`, burns the subtitle in using the **same** helpers the
streamer uses (`resolveSubtitleToTemp` + `subtitleFilterFragment`), then proves the
text actually rendered by diffing a frame with vs without the filter.

It **requires an FFmpeg built with libass** (the `subtitles` filter). If your FFmpeg
lacks it, the test prints `⏭ SKIPPED` and exits 0 — the app itself detects the same
thing and simply skips burn-in rather than failing playback. Check your build with:

```bash
ffmpeg -filters | grep ' subtitles '   # present ⇒ burn-in works
```

macOS: `brew install ffmpeg` ships libass. Debian/Ubuntu: the distro `ffmpeg`
package includes it. A stripped/minimal build may not.

## Manual — mobile drag-to-reorder

Reordering is driven by **Pointer Events** off the `⠿` handle, so it works with
touch as well as a mouse (native HTML5 drag never fires on a touchscreen).

1. `npm run build` then `npm start` (or `npm run dev`), open the dashboard, point it
   at a library so the queue fills.
2. In Chrome/Firefox DevTools, toggle **device emulation** (touch mode) — or use a
   real phone over the SSH tunnel.
3. Press-and-drag the `⠿` handle on a queued title up/down. The drop target shows a
   green top border; releasing moves the item. Confirm:
   - the list does **not** scroll while dragging from the handle (it does when you
     swipe elsewhere on the row),
   - the new order persists (it round-trips through `POST /api/queue/reorder`),
   - the handle and the CC/✕ buttons are **visible without hovering** on touch.
4. Desktop regression: dragging a movie from the **Library** panel into the queue
   (native drag) still drops at the right spot.

## Manual — per-title subtitles

1. Put a subtitle next to a movie: `Movie.srt`, `Movie.en.srt`, or `Subs/English.srt`.
2. On a queued title, tap **CC** → the picker lists the detected subtitles. Pick one;
   a green **CC** badge appears on that title. **Browse…** lets you find a `.srt`
   elsewhere under the media root (it opens in the movie's folder).
3. Adjust **Font size** — it's a global on-screen size.
4. Go live (or restart that title): the subtitle is burned into the stream. Picks
   apply **when the title next starts** (we don't interrupt a track mid-play).
5. If the server's FFmpeg has no libass, the picker shows a warning and the pick is
   saved but won't render — by design.
