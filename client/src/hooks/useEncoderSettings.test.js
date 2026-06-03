import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEncoderSettings } from './useEncoderSettings';

beforeEach(() => localStorage.clear());

describe('useEncoderSettings.buildEncodePayload', () => {
  it('returns exactly the server encode-payload contract', () => {
    const { result } = renderHook(() => useEncoderSettings());
    const p = result.current.buildEncodePayload();
    expect(Object.keys(p).sort()).toEqual(
      [
        'advanced',
        'audioBitrate',
        'audioChannels',
        'autoRestart',
        'bitrate',
        'fit',
        'fps',
        'order',
        'resolution',
        'showTitle',
      ].sort(),
    );
  });

  it('coerces fps and audioChannels to numbers and passes adv through by reference', () => {
    const { result } = renderHook(() => useEncoderSettings());
    const p = result.current.buildEncodePayload();
    expect(typeof p.fps).toBe('number');
    expect(typeof p.audioChannels).toBe('number');
    expect(p.advanced).toBe(result.current.adv);
    expect(p.showTitle).toBe(true); // overlay defaults on
  });
});

describe('useEncoderSettings persistence/migration', () => {
  it('migrates the legacy rs_rc key into adv.rateControl', () => {
    localStorage.setItem('rs_rc', 'vbr');
    const { result } = renderHook(() => useEncoderSettings());
    expect(result.current.adv.rateControl).toBe('vbr');
  });

  it('falls back to platform defaults when rs_adv is invalid JSON', () => {
    localStorage.setItem('rs_adv', '{not valid json');
    const { result } = renderHook(() => useEncoderSettings());
    expect(result.current.adv.preset).toBe('veryfast');
    expect(result.current.adv.rateControl).toBe('cbr');
  });
});
