import { VIDEO_BITRATES, AUDIO_BITRATES, PRESETS, PROFILES, TUNES, PIXFMTS, ACODECS, ARATES } from '../lib/constants';

// Slide-over settings: library folder, RTMP destination, and the full encoder
// block. All setters from useEncoderSettings persist to localStorage as you type;
// "Apply" is the only thing that pushes to a running stream (next-track boundary).
export default function SettingsDrawer({
  onClose,
  queue,
  settings,
  folderPath,
  setFolderPath,
  onBrowse,
  busy,
  onUseFolder,
  onApply,
  streaming,
}) {
  const s = settings;
  return (
    <>
      {/* Decorative backdrop; click-to-dismiss is a convenience — the accessible close path is the ✕ button below. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer scrollable">
        <div className="drawer-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="drawer-section">
          <h3>Movie library</h3>
          <p className="muted" style={{ marginBottom: '0.6rem' }}>
            {queue?.library || 'none set'} · {queue?.libraryCount || 0} movies
            {queue?.minMovieMB != null ? ` · ignoring < ${queue.minMovieMB}MB` : ''}
          </p>
          <div className="row">
            <input
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="Folder under media root…"
            />
            <button className="btn btn-secondary btn-small" onClick={onBrowse}>
              Browse
            </button>
          </div>
          <label className="field">
            Smallest file to include (MB)
            <input
              type="number"
              min="0"
              step="1"
              value={s.minSizeMB}
              onChange={(e) => s.setMinSizeMB(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary btn-small btn-full"
            onClick={onUseFolder}
            disabled={busy || (!folderPath.trim() && !queue?.library)}
          >
            {busy ? 'Scanning…' : folderPath.trim() ? 'Use this folder' : 'Rescan with these settings'}
          </button>
        </div>

        <div className="drawer-section">
          <h3>Destination</h3>
          <label className="field">
            RTMP URL
            <input type="text" value={s.rtmpUrl} onChange={(e) => s.setRtmpUrl(e.target.value)} />
          </label>
          <label className="field">
            Stream key
            <input
              type="password"
              value={s.streamKey}
              onChange={(e) => s.setStreamKey(e.target.value)}
              placeholder="paste your key"
            />
          </label>
        </div>

        <div className="drawer-section">
          <h3>Stream settings</h3>
          <p className="hint">
            Defaults are platform-safe for Twitch / Kick / AngelThump (x264 High, CBR, 2s keyframes, yuv420p, 48 kHz
            AAC). Leave Max rate / Buf size blank to derive them from the bitrate. While streaming, changes apply at the
            next track boundary — no reconnect.
          </p>
          <div className="grid-2">
            <label className="field">
              Resolution
              <select value={s.resolution} onChange={(e) => s.setResolution(e.target.value)}>
                <option value="1280x720">720p</option>
                <option value="1920x1080">1080p</option>
                <option value="2560x1440">1440p</option>
              </select>
            </label>
            <label className="field">
              Fit
              <select value={s.videoFit} onChange={(e) => s.setVideoFit(e.target.value)}>
                <option value="fit">Fit (bars)</option>
                <option value="stretch">Stretch</option>
                <option value="crop">Crop to fill</option>
              </select>
            </label>
            <label className="field">
              Frame rate
              <select value={s.fps} onChange={(e) => s.setFps(e.target.value)}>
                <option value="24">24 fps</option>
                <option value="30">30 fps</option>
                <option value="60">60 fps</option>
              </select>
            </label>
            <label className="field">
              Playback order
              <select value={s.order} onChange={(e) => s.setOrder(e.target.value)}>
                <option value="shuffle">Shuffle</option>
                <option value="sequential">In order (A→Z)</option>
              </select>
            </label>
            <label className="field">
              Video bitrate
              <input
                list="dl-vb"
                value={s.bitrate}
                onChange={(e) => s.setBitrate(e.target.value)}
                placeholder="e.g. 1.2M or 1500k"
              />
              <datalist id="dl-vb">
                {VIDEO_BITRATES.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </label>
            <label className="field">
              Rate control
              <select value={s.adv.rateControl} onChange={(e) => s.setAdvField('rateControl', e.target.value)}>
                <option value="cbr">CBR (steady)</option>
                <option value="vbr">VBR (capped)</option>
                <option value="crf">CRF (quality)</option>
              </select>
            </label>
            <label className="field">
              Max rate
              <input
                value={s.adv.maxrate}
                onChange={(e) => s.setAdvField('maxrate', e.target.value)}
                placeholder="= bitrate"
              />
            </label>
            <label className="field">
              Buf size
              <input
                value={s.adv.bufsize}
                onChange={(e) => s.setAdvField('bufsize', e.target.value)}
                placeholder="= 2× bitrate"
              />
            </label>
            <label className="field">
              CRF
              <input
                type="number"
                min="0"
                max="51"
                value={s.adv.crf}
                onChange={(e) => s.setAdvField('crf', e.target.value)}
              />
            </label>
            <label className="field">
              Keyframe (sec)
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={s.adv.gopSeconds}
                onChange={(e) => s.setAdvField('gopSeconds', e.target.value)}
              />
            </label>
            <label className="field">
              Preset
              <input list="dl-preset" value={s.adv.preset} onChange={(e) => s.setAdvField('preset', e.target.value)} />
            </label>
            <label className="field">
              Profile
              <input
                list="dl-profile"
                value={s.adv.profile}
                onChange={(e) => s.setAdvField('profile', e.target.value)}
                placeholder="high / main / none"
              />
            </label>
            <label className="field">
              Tune
              <input
                list="dl-tune"
                value={s.adv.tune}
                onChange={(e) => s.setAdvField('tune', e.target.value)}
                placeholder="(none)"
              />
            </label>
            <label className="field">
              Level
              <input
                value={s.adv.level}
                onChange={(e) => s.setAdvField('level', e.target.value)}
                placeholder="(auto) e.g. 4.1"
              />
            </label>
            <label className="field">
              B-frames
              <input
                type="number"
                min="0"
                value={s.adv.bframes}
                onChange={(e) => s.setAdvField('bframes', e.target.value)}
              />
            </label>
            <label className="field">
              Scene-cut
              <input type="number" value={s.adv.sceneCut} onChange={(e) => s.setAdvField('sceneCut', e.target.value)} />
            </label>
            <label className="field">
              Pixel format
              <input list="dl-pixfmt" value={s.adv.pixfmt} onChange={(e) => s.setAdvField('pixfmt', e.target.value)} />
            </label>
            <label className="field">
              Audio channels
              <select value={s.audioChannels} onChange={(e) => s.setAudioChannels(e.target.value)}>
                <option value="2">Stereo</option>
                <option value="1">Mono</option>
              </select>
            </label>
            <label className="field">
              Audio bitrate
              <select value={s.audioBitrate} onChange={(e) => s.setAudioBitrate(e.target.value)}>
                {AUDIO_BITRATES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Audio codec
              <input
                list="dl-acodec"
                value={s.adv.audioCodec}
                onChange={(e) => s.setAdvField('audioCodec', e.target.value)}
              />
            </label>
            <label className="field">
              Audio rate
              <input
                list="dl-arate"
                value={s.adv.audioSampleRate}
                onChange={(e) => s.setAdvField('audioSampleRate', e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            Extra ffmpeg args <span className="muted">(output options — power user)</span>
            <input
              value={s.adv.extraArgs}
              onChange={(e) => s.setAdvField('extraArgs', e.target.value)}
              placeholder={'-x264-params "keyint=60:scenecut=0" -aq-mode 3'}
            />
          </label>
          <label
            className="check-row"
            title="If the stream drops, automatically reconnect and resume the same movie at the same spot. Clicking Stop always wins."
          >
            <input type="checkbox" checked={s.autoRestart} onChange={(e) => s.setAutoRestart(e.target.checked)} />
            <span>
              Auto-restart if the stream fails <span className="muted">(resumes where it left off)</span>
            </span>
          </label>
          <label
            className="check-row"
            title="Burn the current movie's name into the bottom-left of the video. You can also flip this live from the Now Playing panel."
          >
            <input type="checkbox" checked={s.showTitle} onChange={(e) => s.setShowTitle(e.target.checked)} />
            <span>
              Show movie title on screen <span className="muted">(bottom-left overlay)</span>
            </span>
          </label>
          <button className="btn btn-secondary btn-small" onClick={s.resetAdv}>
            Reset encoder to platform defaults
          </button>
          <datalist id="dl-preset">
            {PRESETS.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id="dl-profile">
            {PROFILES.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id="dl-tune">
            {TUNES.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id="dl-pixfmt">
            {PIXFMTS.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id="dl-acodec">
            {ACODECS.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id="dl-arate">
            {ARATES.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </div>

        <div className="drawer-footer">
          <button className="btn btn-primary btn-full" onClick={onApply} disabled={busy}>
            {streaming ? 'Apply settings (next track)' : 'Save settings'}
          </button>
          <p className="hint" style={{ marginTop: '0.4rem' }}>
            {streaming
              ? 'Encoder changes are pushed to the live stream and take effect at the next movie — the RTMP connection stays up.'
              : 'Saved to this browser and used the next time you Go Live.'}
          </p>
        </div>
      </aside>
    </>
  );
}
