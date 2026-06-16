import { useRef, useState } from 'react';
import { niceName, fmtDuration } from '../lib/format';
import { targetIndexFromPointer } from '../lib/dragReorder';

// The "Up Next" list: search, drag-to-reorder, and drag-from-library targets.
// Reordering is driven by Pointer Events off the ⠿ handle so it works on touch
// (mobile) as well as mouse — native HTML5 drag, used by the library panel to drop
// items in, never fires on a touchscreen. The rows stay native drop targets so a
// desktop library→queue drag still lands at the right spot. Cross-list drag state
// (dragRef/overIndex) lives in the orchestrator because a library drag crosses
// into this list.
export default function QueueList({
  files,
  filtered,
  searching,
  query,
  setQuery,
  currentIndex,
  streaming,
  dragRef,
  overIndex,
  setOverIndex,
  dropAt,
  removeAt,
  durations = {},
  subtitles = {},
  onPickSubtitle,
  totalSeconds = 0,
  totalKnown = true,
}) {
  const total = fmtDuration(totalSeconds);
  const listRef = useRef(null);
  const dragState = useRef(null); // { pointerId, fromIndex } while a handle drag is live
  const [dragging, setDragging] = useState(null); // index being dragged (for styling)

  // Current row rectangles in visual order, for pointer hit-testing.
  const collectRows = () => {
    const nodes = listRef.current?.querySelectorAll('[data-track-index]') || [];
    return [...nodes].map((n) => {
      const r = n.getBoundingClientRect();
      return { index: parseInt(n.dataset.trackIndex, 10), top: r.top, bottom: r.bottom };
    });
  };

  const onHandlePointerDown = (e, index) => {
    if (searching || e.button > 0) return; // only the primary button / touch; no reorder while filtered
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — move/up still work, just without guaranteed delivery */
    }
    dragRef.current = { source: 'queue', fromIndex: index };
    dragState.current = { pointerId: e.pointerId, fromIndex: index };
    setOverIndex(index);
    setDragging(index);
  };

  const onHandlePointerMove = (e) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    const target = targetIndexFromPointer(e.clientY, collectRows());
    if (target != null) setOverIndex(target);
  };

  const endHandleDrag = (e, commit) => {
    const st = dragState.current;
    if (!st || e.pointerId !== st.pointerId) return;
    dragState.current = null;
    setDragging(null);
    if (commit) {
      const target = targetIndexFromPointer(e.clientY, collectRows());
      if (target != null) {
        dropAt(target); // reuses the same reorder path as a native drop
        return;
      }
    }
    dragRef.current = null;
    setOverIndex(null);
  };

  return (
    <section
      className="queue"
      onDragOver={(e) => {
        if (dragRef.current) e.preventDefault();
      }}
      onDrop={() => dropAt(files.length)}
    >
      <div className="queue-head">
        <div>
          <h2 className="queue-title">Up Next</h2>
          <span className="muted">
            {files.length} queued · auto-fills under 5{total ? ` · ${total}${totalKnown ? '' : '+'} total` : ''}
          </span>
        </div>
        <input
          className="search"
          type="search"
          value={query}
          placeholder="Search the queue…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {searching && <p className="hint">Showing {filtered.length} match(es). Clear search to reorder.</p>}

      <div className="queue-list" ref={listRef}>
        {filtered.length === 0 && (
          <div className="empty-state">
            {searching ? `No matches for “${query}”.` : 'Drag movies here from the library →'}
          </div>
        )}
        {filtered.map(({ path, index }) => {
          const playing = index === currentIndex;
          const showDivider = streaming && !searching && index === currentIndex + 1;
          const hasSub = !!subtitles[path];
          return (
            <div key={`${path}-${index}`}>
              {showDivider && <div className="next-divider">Up next</div>}
              <div
                data-track-index={index}
                className={`track ${playing ? 'playing' : ''} ${dragging === index ? 'dragging' : ''} ${
                  overIndex === index ? 'drop-target' : ''
                }`}
                onDragEnter={() => setOverIndex(index)}
                onDragOver={(e) => {
                  if (dragRef.current) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.stopPropagation();
                  dropAt(index);
                }}
              >
                {!searching && (
                  <span
                    className="track-handle"
                    title="Drag to reorder"
                    onPointerDown={(e) => onHandlePointerDown(e, index)}
                    onPointerMove={onHandlePointerMove}
                    onPointerUp={(e) => endHandleDrag(e, true)}
                    onPointerCancel={(e) => endHandleDrag(e, false)}
                  >
                    ⠿
                  </span>
                )}
                <span className="track-num">{playing ? '♪' : index + 1}</span>
                <span className="track-name">{niceName(path)}</span>
                {hasSub && (
                  <span className="track-cc-badge" title={`Subtitles: ${subtitles[path].label}`}>
                    CC
                  </span>
                )}
                {durations[path] ? <span className="track-dur">{fmtDuration(durations[path])}</span> : null}
                <div className="track-actions">
                  {onPickSubtitle && (
                    <button
                      className={`icon-btn cc-btn${hasSub ? ' active' : ''}`}
                      title={hasSub ? `Subtitles: ${subtitles[path].label} — tap to change` : 'Choose subtitles'}
                      onClick={() => onPickSubtitle(path)}
                    >
                      CC
                    </button>
                  )}
                  <button className="icon-btn danger" title="Remove" onClick={() => removeAt(index)}>
                    ✕
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
