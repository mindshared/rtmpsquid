import { useEffect, useMemo, useState } from 'react';
import { niceName, basename, fmtDuration } from '../lib/format';
import { LIB_PAGE } from '../lib/constants';

const EMPTY = []; // stable reference so the useMemo below isn't busted every render

// Browseable library (right column). Search + pagination state is local to this
// panel since nothing else needs it. Rows are draggable into the queue; + adds.
export default function LibraryPanel({ library, dragRef, addAt }) {
  const durations = library?.durations || {};
  const [libQuery, setLibQuery] = useState('');
  const [libPage, setLibPage] = useState(0);

  const files = library?.files || EMPTY;

  const libFiltered = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    return files.filter((p) => !q || basename(p).toLowerCase().includes(q));
  }, [files, libQuery]);

  const libPageCount = Math.max(1, Math.ceil(libFiltered.length / LIB_PAGE));
  const safePage = Math.min(libPage, libPageCount - 1);
  const libPageItems = libFiltered.slice(safePage * LIB_PAGE, safePage * LIB_PAGE + LIB_PAGE);
  useEffect(() => {
    setLibPage(0);
  }, [libQuery]); // back to page 1 on a new search

  return (
    <aside className="library-panel">
      <div className="lib-head">
        <h2 className="queue-title" style={{ fontSize: '1.1rem' }}>
          Library
        </h2>
        <span className="muted">{files.length} movies</span>
      </div>
      <input
        className="search lib-search"
        type="search"
        value={libQuery}
        placeholder="Search library…"
        onChange={(e) => setLibQuery(e.target.value)}
      />
      <p className="hint">Drag a movie into the queue, or tap +</p>
      <div className="lib-list scrollable">
        {libFiltered.length === 0 && <div className="empty-state">No movies match.</div>}
        {libPageItems.map((path) => (
          <div
            key={path}
            className="lib-row"
            draggable
            onDragStart={() => {
              dragRef.current = { source: 'library', path };
            }}
            title={path}
          >
            <span className="lib-handle">⠿</span>
            <span className="lib-name">{niceName(path)}</span>
            {durations[path] ? <span className="lib-dur">{fmtDuration(durations[path])}</span> : null}
            <button className="icon-btn" title="Add to queue" onClick={() => addAt(path, null)}>
              ＋
            </button>
          </div>
        ))}
      </div>
      {libPageCount > 1 && (
        <div className="lib-pager">
          <button
            className="btn btn-secondary btn-small"
            disabled={safePage <= 0}
            onClick={() => setLibPage(safePage - 1)}
          >
            ‹ Prev
          </button>
          <span className="muted">
            {safePage * LIB_PAGE + 1}–{Math.min((safePage + 1) * LIB_PAGE, libFiltered.length)} of {libFiltered.length}{' '}
            · page {safePage + 1}/{libPageCount}
          </span>
          <button
            className="btn btn-secondary btn-small"
            disabled={safePage >= libPageCount - 1}
            onClick={() => setLibPage(safePage + 1)}
          >
            Next ›
          </button>
        </div>
      )}
    </aside>
  );
}
