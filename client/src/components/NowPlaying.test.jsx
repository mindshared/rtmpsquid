import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NowPlaying from './NowPlaying';

const base = {
  status: { status: 'streaming', progress: { filePositionSec: 90 } },
  currentFile: 'Movie.2021.mkv',
  onStop: () => {},
  onNext: () => {},
  onPause: () => {},
};

describe('NowPlaying subtitles button', () => {
  it('shows the Subtitles button while live and fires onPickSubtitle', () => {
    const onPick = vi.fn();
    render(<NowPlaying {...base} onPickSubtitle={onPick} hasSubtitle={false} />);
    const btn = screen.getByRole('button', { name: /Subtitles/i });
    fireEvent.click(btn);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('reflects an active subtitle in the label', () => {
    render(<NowPlaying {...base} onPickSubtitle={() => {}} hasSubtitle />);
    expect(screen.getByRole('button', { name: /Subtitles: On/i })).toBeInTheDocument();
  });

  it('hides the Subtitles button on the standby slate', () => {
    render(
      <NowPlaying {...base} status={{ status: 'standby', progress: {} }} onPickSubtitle={() => {}} hasSubtitle={false} />,
    );
    expect(screen.queryByRole('button', { name: /Subtitles/i })).toBeNull();
  });

  it('shows the current movie position (not session uptime) while live', () => {
    render(<NowPlaying {...base} onPickSubtitle={() => {}} />);
    expect(screen.getByText('0:01:30')).toBeInTheDocument(); // filePositionSec=90 → 0:01:30
  });
});
