import { fmtBytes } from '../lib/format';

const pct = (n) => Math.round(n || 0);

// Compact live resource chip. The headline CPU number is the share of TOTAL
// system capacity (across all cores), so it stays 0–100% and reads sensibly on
// multi-core boxes; the tooltip keeps the raw per-process "% of one core"
// breakdown. Renders nothing until the first stats snapshot.
function StatsChip({ stats }) {
  if (!stats || !stats.total) return null;
  const cores = stats.system?.cores || 1;
  // Sum of per-process "% of one core" ÷ cores = % of the whole machine.
  const cpuAll = Math.min(100, Math.round((stats.total.cpuPct || 0) / cores));
  const tip = [
    `Node: ${pct(stats.node?.cpuPct)}% of a core · ${fmtBytes(stats.node?.rssBytes)}`,
    ...(stats.ffmpeg || []).map((p) => `${p.role}: ${pct(p.cpuPct)}% of a core · ${fmtBytes(p.rssBytes)}`),
    `Total CPU: ${cpuAll}% of ${cores} core${cores === 1 ? '' : 's'}  (${pct(stats.total.cpuPct)}% of one core)`,
    `System: load ${(stats.system?.loadavg?.[0] || 0).toFixed(2)} · ${fmtBytes(stats.system?.freeMem)} free of ${fmtBytes(stats.system?.totalMem)}`,
  ].join('\n');
  return (
    <span className="appbar-stats" title={tip}>
      ▣ {cpuAll}% CPU · {fmtBytes(stats.total.rssBytes)}
    </span>
  );
}

// Top bar: brand + context actions. Which transport button shows depends on
// whether we're live, paused, or idle.
export default function AppBar({
  hasLibrary,
  streaming,
  paused,
  busy,
  stats,
  onReshuffle,
  onOpenSettings,
  onPause,
  onResume,
  onStop,
  onGoLive,
  onLogout,
}) {
  return (
    <header className="appbar">
      <div className="brand">🦑 RTMP Squid</div>
      <StatsChip stats={stats} />
      <div className="appbar-actions">
        {hasLibrary && (
          <button
            className="btn btn-secondary btn-small"
            onClick={onReshuffle}
            disabled={busy}
            title="Fresh random queue"
          >
            🔀 Shuffle
          </button>
        )}
        <button className="btn btn-secondary btn-small" onClick={onOpenSettings}>
          ⚙ Settings
        </button>
        {streaming && (
          <button
            className="btn btn-secondary btn-small"
            onClick={onPause}
            disabled={busy}
            title="Go offline but keep your place"
          >
            ⏸ Pause
          </button>
        )}
        {paused && (
          <button className="btn btn-primary btn-small" onClick={onResume} disabled={busy}>
            ▶ Resume
          </button>
        )}
        {streaming || paused ? (
          <button className="btn btn-danger btn-small" onClick={onStop} disabled={busy}>
            ■ Stop
          </button>
        ) : (
          <button className="btn btn-primary btn-small" onClick={onGoLive} disabled={!hasLibrary || busy}>
            ● Go Live
          </button>
        )}
        <button className="btn btn-secondary btn-small" onClick={onLogout} title="Log out">
          ⏻
        </button>
      </div>
    </header>
  );
}
