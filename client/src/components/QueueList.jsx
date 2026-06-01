import { niceName, fmtDuration } from '../lib/format';

// The "Up Next" list: search, drag-to-reorder, and drag-from-library targets.
// Drag state (dragRef/overIndex) and the drop handler live in the orchestrator
// because a drag can cross between this list and the library panel.
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
  totalSeconds = 0,
  totalKnown = true,
}) {
  const total = fmtDuration(totalSeconds);
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
      {searching && <p className="hint">Showing {filtered.length} match(es). Clear search to drag.</p>}

      <div className="queue-list">
        {filtered.length === 0 && (
          <div className="empty-state">
            {searching ? `No matches for “${query}”.` : 'Drag movies here from the library →'}
          </div>
        )}
        {filtered.map(({ path, index }) => {
          const playing = index === currentIndex;
          const showDivider = streaming && !searching && index === currentIndex + 1;
          return (
            <div key={`${path}-${index}`}>
              {showDivider && <div className="next-divider">Up next</div>}
              <div
                className={`track ${playing ? 'playing' : ''} ${overIndex === index ? 'drop-target' : ''}`}
                draggable={!searching}
                onDragStart={() => {
                  dragRef.current = { source: 'queue', fromIndex: index };
                }}
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
                  <span className="track-handle" title="Drag to reorder">
                    ⠿
                  </span>
                )}
                <span className="track-num">{playing ? '♪' : index + 1}</span>
                <span className="track-name">{niceName(path)}</span>
                {durations[path] ? <span className="track-dur">{fmtDuration(durations[path])}</span> : null}
                <div className="track-actions">
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
