import { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { basename, dirname, formatHMS } from '../lib/format';
import { useLibrary } from '../hooks/useLibrary';
import { useEncoderSettings } from '../hooks/useEncoderSettings';
import { useFfmpegLog } from '../hooks/useFfmpegLog';
import { useStats } from '../hooks/useStats';
import ErrorBoundary from './ErrorBoundary';
import AppBar from './AppBar';
import NowPlaying from './NowPlaying';
import PausedCard from './PausedCard';
import QueueList from './QueueList';
import LibraryPanel from './LibraryPanel';
import SettingsDrawer from './SettingsDrawer';
import FfmpegLogPanel from './FfmpegLogPanel';
import FolderBrowser from './FolderBrowser';
import SubtitlePicker from './SubtitlePicker';
import RecoveryCard from './RecoveryCard';

// Stable empty array so `queue?.files || EMPTY` keeps a constant reference when
// there's no queue — otherwise a fresh [] each render busts the useMemo below.
const EMPTY = [];

// Orchestrator: owns the shared state + server calls and composes the panels.
// Each panel is wrapped in an ErrorBoundary so a render error in one degrades
// just that panel instead of unmounting the whole dashboard.
export default function Dashboard({ socket, queue, streamStatus, setQueue, notify, onLogout, refreshStatus }) {
  const settings = useEncoderSettings();
  const { library, refetchLibrary } = useLibrary(socket);
  const { entries: ffmpegLog, lastStatus } = useFfmpegLog(socket, streamStatus?.log);
  const stats = useStats(socket);

  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [subtitleFor, setSubtitleFor] = useState(null); // queue path whose subtitles we're editing
  const [subtitleBrowse, setSubtitleBrowse] = useState(false); // browsing the filesystem for a .srt
  const [busy, setBusy] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [overIndex, setOverIndex] = useState(null);
  const dragRef = useRef(null); // { source:'library'|'queue', path?, fromIndex? }

  const streaming = !!queue?.streaming;
  const paused = !!queue?.paused;
  const files = queue?.files || EMPTY;
  const currentIndex = streaming && queue?.currentFile ? files.findIndex((f) => basename(f) === queue.currentFile) : -1;
  const nextTrack = currentIndex >= 0 && currentIndex < files.length - 1 ? files[currentIndex + 1] : null;
  const playingPath = currentIndex >= 0 ? files[currentIndex] : null; // absolute path of the now-playing movie
  const searching = query.trim().length > 0;
  const hasLibrary = !!(queue && queue.libraryCount > 0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files
      .map((path, index) => ({ path, index }))
      .filter(({ path }) => !q || basename(path).toLowerCase().includes(q));
  }, [files, query]);

  const call = async (fn, label) => {
    setBusy(true);
    try {
      const { data } = await fn();
      if (data?.files) setQueue(data);
      return data;
    } catch (e) {
      notify?.(`${label}: ${e.response?.data?.error || e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const useFolder = () => {
    const folder = folderPath.trim() || queue?.library;
    if (!folder) {
      notify?.('Choose a folder first', 'error');
      return undefined;
    }
    return call(
      () => api.post('/api/queue/library', { folderPath: folder, minSizeMB: parseFloat(settings.minSizeMB) || 0 }),
      'Library',
    ).then((d) => {
      if (d) {
        notify?.(`Library set · ${d.libraryCount} movies (≥ ${settings.minSizeMB}MB)`);
        setDrawerOpen(false);
        refetchLibrary();
      }
    });
  };
  // Park / un-park a library file so the auto-queue skips (or resumes) it. This
  // returns the library (not the queue), so it bypasses `call`'s setQueue path;
  // the server broadcasts the resulting queue + library over the socket.
  const setExcluded = async (path, excluded) => {
    setBusy(true);
    try {
      await api.post('/api/library/exclude', { filePath: path, excluded });
      refetchLibrary();
    } catch (e) {
      notify?.(`Library: ${e.response?.data?.error || e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  // Set/clear the burned-in subtitle for one title (choice=null clears). A bare
  // fontSize change passes choice=undefined to leave the current pick alone.
  const setSubtitle = (filePath, choice, fontSize) =>
    call(() => api.post('/api/queue/subtitle', { filePath, choice, fontSize }), 'Subtitle');
  const reshuffle = () => call(() => api.post('/api/queue/reshuffle'), 'Shuffle');
  const removeAt = (index) => call(() => api.delete(`/api/queue/${index}`), 'Remove');
  const addAt = (path, index) => call(() => api.post('/api/queue/add', { filePath: path, index }), 'Add');
  // Cherry-pick a single file (possibly outside the scanned library) into the
  // queue. Plays once where it lands and isn't auto-refilled back in afterwards.
  const addFile = (path) =>
    addAt(path, null).then((d) => {
      if (d) notify?.(`Added ${basename(path)} to the queue`);
    });
  const reorder = async (from, to) => {
    if (from == null || to == null || from === to) return;
    const prev = queue; // snapshot for rollback if the request fails
    const arr = [...files];
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    setQueue((q) => ({ ...q, files: arr }));
    const d = await call(() => api.post('/api/queue/reorder', { fromIndex: from, toIndex: to }), 'Reorder');
    if (!d) setQueue(prev); // transport/5xx failure → revert the optimistic move
  };

  // Cross-list drop: library item -> insert; queue item -> reorder.
  const dropAt = (targetIndex) => {
    const d = dragRef.current;
    dragRef.current = null;
    setOverIndex(null);
    if (!d) return;
    if (d.source === 'library') addAt(d.path, targetIndex);
    else if (d.source === 'queue') reorder(d.fromIndex, targetIndex);
  };

  const goLive = async () => {
    if (!settings.streamKey.trim()) {
      notify?.('Add your stream key in Settings', 'error');
      setDrawerOpen(true);
      return;
    }
    const payload = { rtmpUrl: settings.rtmpUrl, streamKey: settings.streamKey, ...settings.buildEncodePayload() };
    const d = await call(() => api.post('/api/queue/start', payload), 'Go live');
    if (d) notify?.('Going live'); // only claim success if the request actually succeeded
  };
  const stop = () => call(() => api.post('/api/queue/stop'), 'Stop');
  const skipNext = () => call(() => api.post('/api/queue/next'), 'Next');
  // On-the-fly on-screen-title toggle. Hits the live endpoint (instant, no
  // reconnect) and remembers the choice as the default for the next Go Live.
  const toggleTitle = () => {
    const next = !(streamStatus?.showTitle !== false); // invert the current effective state
    settings.setShowTitle(next);
    return call(() => api.post('/api/queue/title', { show: next }), 'Title');
  };
  const pause = () =>
    call(() => api.post('/api/queue/pause'), 'Pause').then((d) => {
      if (d) notify?.('Paused — you can change settings, then Resume');
    });
  // resume/recover take an optional exact offset (seconds) from an H:M:S field.
  const resume = (offset) =>
    call(() => api.post('/api/queue/resume', offset != null ? { offset } : {}), 'Resume').then((d) => {
      if (d) notify?.(offset != null ? `Resuming at ${formatHMS(offset)}` : 'Resuming where you left off');
    });
  // Live jump: move the currently-playing movie to an exact time (no reconnect).
  const seekTo = (offset) =>
    call(() => api.post('/api/queue/seek', { offset }), 'Jump').then((d) => {
      if (d?.success) notify?.(`Jumped to ${formatHMS(d.offset)}`);
    });
  // Recovery card actions: resume the crashed movie at a time, re-queue a skipped
  // one to play next, or dismiss the card.
  const recover = (offset) =>
    call(() => api.post('/api/queue/recover', offset != null ? { offset } : {}), 'Resume').then((d) => {
      if (d) notify?.(offset != null ? `Resuming at ${formatHMS(offset)}` : 'Resuming the movie');
    });
  const dismissIncident = () => call(() => api.post('/api/queue/incident/clear'), 'Dismiss');
  const requeueIncident = (path) =>
    addAt(path, currentIndex >= 0 ? currentIndex + 1 : 0).then((d) => {
      if (d) {
        notify?.(`${basename(path)} will play next`);
        dismissIncident();
      }
    });

  // "Apply" is the only thing that pushes settings to a running stream (next
  // track), so a stale tab can never silently overwrite the live encoder.
  const applySettings = () => {
    if (streaming) {
      return call(() => api.post('/api/queue/settings', settings.buildEncodePayload()), 'Apply').then((d) => {
        if (d) {
          notify?.('Settings applied — takes effect at the next track');
          refreshStatus?.(); // pull the new target so the "X target" display updates immediately
        }
      });
    }
    notify?.('Settings saved');
    return undefined;
  };

  return (
    <div className="player-shell wide">
      <ErrorBoundary label="Toolbar" compact>
        <AppBar
          hasLibrary={hasLibrary}
          streaming={streaming}
          paused={paused}
          busy={busy}
          stats={stats}
          onReshuffle={reshuffle}
          onOpenSettings={() => setDrawerOpen(true)}
          onPause={pause}
          onResume={resume}
          onStop={stop}
          onGoLive={goLive}
          onLogout={onLogout}
        />
      </ErrorBoundary>

      {!queue ? (
        <div className="empty-state">Loading…</div>
      ) : !hasLibrary ? (
        <section className="empty-create">
          <div className="empty-art">🎬</div>
          <h2>Point me at your movies</h2>
          <p>Pick a folder and I&apos;ll auto-fill a never-ending random queue.</p>
          <button className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
            Choose folder
          </button>
        </section>
      ) : (
        <div className="player-grid">
          <main className="player-body scrollable">
            {queue.lastIncident && (
              <ErrorBoundary label="Recovery" compact>
                <RecoveryCard
                  incident={queue.lastIncident}
                  streaming={streaming}
                  onRecover={recover}
                  onRequeue={requeueIncident}
                  onDismiss={dismissIncident}
                />
              </ErrorBoundary>
            )}
            {streaming && (
              <ErrorBoundary label="Now playing" compact>
                <NowPlaying
                  status={streamStatus}
                  currentFile={queue.currentFile}
                  nextTrack={nextTrack}
                  showTitle={streamStatus?.showTitle !== false}
                  onStop={stop}
                  onNext={skipNext}
                  onPause={pause}
                  onSeek={seekTo}
                  onToggleTitle={toggleTitle}
                  subtitlePath={playingPath}
                  hasSubtitle={!!(playingPath && queue?.subtitles?.[playingPath])}
                  onPickSubtitle={playingPath ? () => setSubtitleFor(playingPath) : null}
                />
              </ErrorBoundary>
            )}
            {paused && (
              <ErrorBoundary label="Paused" compact>
                <PausedCard queue={queue} onResume={resume} onStop={stop} />
              </ErrorBoundary>
            )}

            {(streaming || paused) && (
              <ErrorBoundary label="ffmpeg log" compact>
                <FfmpegLogPanel entries={ffmpegLog} lastStatus={lastStatus} />
              </ErrorBoundary>
            )}

            <ErrorBoundary label="Queue" compact>
              <QueueList
                files={files}
                filtered={filtered}
                searching={searching}
                query={query}
                setQuery={setQuery}
                currentIndex={currentIndex}
                streaming={streaming}
                dragRef={dragRef}
                overIndex={overIndex}
                setOverIndex={setOverIndex}
                dropAt={dropAt}
                removeAt={removeAt}
                durations={queue?.durations || {}}
                subtitles={queue?.subtitles || {}}
                onPickSubtitle={(path) => setSubtitleFor(path)}
                totalSeconds={queue?.totalSeconds || 0}
                totalKnown={queue?.totalKnown !== false}
              />
            </ErrorBoundary>
          </main>

          <ErrorBoundary label="Library" compact>
            <LibraryPanel
              library={library}
              dragRef={dragRef}
              addAt={addAt}
              onExclude={setExcluded}
              onPickFile={() => setShowFilePicker(true)}
            />
          </ErrorBoundary>
        </div>
      )}

      {drawerOpen && (
        <ErrorBoundary label="Settings">
          <SettingsDrawer
            onClose={() => setDrawerOpen(false)}
            queue={queue}
            settings={settings}
            folderPath={folderPath}
            setFolderPath={setFolderPath}
            onBrowse={() => setShowBrowser(true)}
            busy={busy}
            onUseFolder={useFolder}
            onApply={applySettings}
            streaming={streaming}
          />
        </ErrorBoundary>
      )}

      {showBrowser && (
        <FolderBrowser
          onSelectFolder={(p) => {
            setFolderPath(p);
            setShowBrowser(false);
          }}
          onClose={() => setShowBrowser(false)}
        />
      )}

      {showFilePicker && <FolderBrowser onAddFile={addFile} onClose={() => setShowFilePicker(false)} />}

      {subtitleFor && !subtitleBrowse && (
        <SubtitlePicker
          filePath={subtitleFor}
          subtitles={queue?.subtitles || {}}
          fontSize={queue?.subtitleFontSize || 20}
          live={streaming && subtitleFor === playingPath}
          onApply={(choice, fontSize) => setSubtitle(subtitleFor, choice, fontSize)}
          onBrowse={() => setSubtitleBrowse(true)}
          onClose={() => setSubtitleFor(null)}
        />
      )}

      {subtitleFor && subtitleBrowse && (
        <FolderBrowser
          startPath={dirname(subtitleFor)}
          onPickSubtitle={(subPath, name) => setSubtitle(subtitleFor, { kind: 'file', path: subPath, label: name })}
          onClose={() => setSubtitleBrowse(false)}
        />
      )}
    </div>
  );
}
