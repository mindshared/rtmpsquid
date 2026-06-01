import { useState } from 'react';
import { ls, normalizeBitrate } from '../lib/format';
import { ADV_DEFAULTS } from '../lib/constants';

/**
 * All destination + encoder settings, persisted to localStorage as you edit them.
 * Centralises persistence so components just read values and call setters; the
 * payload shape sent to /start and /settings is built here in one place.
 */
export function useEncoderSettings() {
  const [rtmpUrl, _setRtmpUrl] = useState(ls('rs_rtmp', 'rtmp://ingest.angelthump.com/live'));
  const [streamKey, _setStreamKey] = useState(ls('rs_key', ''));
  const [resolution, _setResolution] = useState(ls('rs_res', '1920x1080'));
  const [videoFit, _setVideoFit] = useState(ls('rs_fit', 'fit'));
  const [bitrate, _setBitrate] = useState(normalizeBitrate(ls('rs_vb', '3M')));
  const [audioBitrate, _setAudioBitrate] = useState(ls('rs_ab', '160k'));
  const [fps, _setFps] = useState(ls('rs_fps', '30'));
  const [audioChannels, _setAudioChannels] = useState(ls('rs_ac', '2'));
  const [order, _setOrder] = useState(ls('rs_order', 'shuffle'));
  const [minSizeMB, _setMinSizeMB] = useState(ls('rs_minmb', '5'));
  const [autoRestart, _setAutoRestart] = useState(ls('rs_autorestart', '1') === '1');

  // Single authoritative encoder block. One-shot migration seeds adv.rateControl
  // from the legacy rs_rc key written by an earlier two-mode build.
  const [adv, setAdv] = useState(() => {
    let stored = {};
    try {
      stored = JSON.parse(ls('rs_adv', '{}')) || {};
    } catch {}
    const legacyRc = ls('rs_rc', null);
    if (legacyRc && !stored.rateControl) stored.rateControl = legacyRc;
    return { ...ADV_DEFAULTS, ...stored };
  });

  const persist = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };
  const mk = (key, setter) => (v) => {
    persist(key, v);
    setter(v);
  };

  const setRtmpUrl = mk('rs_rtmp', _setRtmpUrl);
  const setStreamKey = mk('rs_key', _setStreamKey);
  const setResolution = mk('rs_res', _setResolution);
  const setVideoFit = mk('rs_fit', _setVideoFit);
  const setBitrate = mk('rs_vb', _setBitrate);
  const setAudioBitrate = mk('rs_ab', _setAudioBitrate);
  const setFps = mk('rs_fps', _setFps);
  const setAudioChannels = mk('rs_ac', _setAudioChannels);
  const setOrder = mk('rs_order', _setOrder);
  const setMinSizeMB = mk('rs_minmb', _setMinSizeMB);
  const setAutoRestart = (v) => {
    persist('rs_autorestart', v ? '1' : '0');
    _setAutoRestart(v);
  };

  const setAdvField = (k, v) => {
    const next = { ...adv, [k]: v };
    setAdv(next);
    persist('rs_adv', JSON.stringify(next));
  };
  const resetAdv = () => {
    setAdv({ ...ADV_DEFAULTS });
    persist('rs_adv', JSON.stringify(ADV_DEFAULTS));
  };

  // The encode-options payload shared by /start and the live /settings push.
  const buildEncodePayload = () => ({
    resolution,
    bitrate: normalizeBitrate(bitrate),
    audioBitrate,
    audioChannels: parseInt(audioChannels, 10),
    fps: parseInt(fps, 10),
    order,
    fit: videoFit,
    autoRestart,
    advanced: adv,
  });

  return {
    rtmpUrl,
    setRtmpUrl,
    streamKey,
    setStreamKey,
    resolution,
    setResolution,
    videoFit,
    setVideoFit,
    bitrate,
    setBitrate,
    audioBitrate,
    setAudioBitrate,
    fps,
    setFps,
    audioChannels,
    setAudioChannels,
    order,
    setOrder,
    minSizeMB,
    setMinSizeMB,
    autoRestart,
    setAutoRestart,
    adv,
    setAdvField,
    resetAdv,
    buildEncodePayload,
  };
}
