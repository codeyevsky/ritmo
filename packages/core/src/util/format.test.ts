import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatBitrate,
  formatBytes,
  formatCount,
  formatDuration,
  formatDurationLong,
  formatRelative,
  formatReleaseYear,
  formatTrackPosition,
} from './format';

describe('formatDuration', () => {
  it('renders the zeroed clock for an unknown or zero length', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(-5_000)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });

  it('zero-pads seconds but not the leading unit', () => {
    expect(formatDuration(1_000)).toBe('0:01');
    expect(formatDuration(67_000)).toBe('1:07');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('adds an hours field only once there is an hour', () => {
    expect(formatDuration(3_599_000)).toBe('59:59');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('truncates the sub-second remainder instead of rounding up', () => {
    // 59_999 must not display as 1:00 — the seek bar would show a second that
    // the track does not have.
    expect(formatDuration(59_999)).toBe('0:59');
    expect(formatDuration(999)).toBe('0:00');
  });
});

describe('formatDurationLong', () => {
  it('falls back to 0 minutes for an unusable length', () => {
    expect(formatDurationLong(0, 'tr')).toBe('0 dk');
    expect(formatDurationLong(-1, 'en')).toBe('0 min');
    expect(formatDurationLong(Number.NaN, 'en')).toBe('0 min');
  });

  it('renders seconds only below a minute', () => {
    expect(formatDurationLong(5_000, 'tr')).toBe('5 sn');
    expect(formatDurationLong(5_000, 'en')).toBe('5 sec');
  });

  it('renders minutes only below an hour', () => {
    expect(formatDurationLong(67_000, 'tr')).toBe('1 dk');
    expect(formatDurationLong(67_000, 'en')).toBe('1 min');
  });

  it('drops the minutes field when it is zero', () => {
    expect(formatDurationLong(3_600_000, 'tr')).toBe('1 sa');
    expect(formatDurationLong(3_600_000, 'en')).toBe('1 hr');
  });

  it('renders hours and minutes together', () => {
    expect(formatDurationLong(3_725_000, 'tr')).toBe('1 sa 2 dk');
    expect(formatDurationLong(3_725_000, 'en')).toBe('1 hr 2 min');
  });

  it('groups a four-digit hour count with the locale separator', () => {
    expect(formatDurationLong(3_600_000_000, 'tr')).toBe('1.000 sa');
    expect(formatDurationLong(3_600_000_000, 'en')).toBe('1,000 hr');
  });
});

describe('formatCount', () => {
  it('leaves values under a thousand un-abbreviated', () => {
    expect(formatCount(0, 'en')).toBe('0');
    expect(formatCount(999, 'tr')).toBe('999');
    expect(formatCount(-999, 'en')).toBe('-999');
  });

  it('uses the locale compact form above a thousand', () => {
    expect(formatCount(1_500, 'en')).toBe('1.5K');
    // Turkish compact notation joins with a no-break space, not U+0020.
    expect(formatCount(1_500, 'tr')).toBe('1,5\u00a0B');
    expect(formatCount(1_234_567, 'en')).toBe('1.2M');
    expect(formatCount(1_234_567, 'tr')).toBe('1,2\u00a0Mn');
  });

  it('keeps the sign on compact negatives', () => {
    expect(formatCount(-2_500, 'en')).toBe('-2.5K');
  });

  it('truncates towards zero before formatting', () => {
    expect(formatCount(1_500.7, 'en')).toBe('1.5K');
    expect(formatCount(999.9, 'en')).toBe('999');
  });

  it('renders zero for a non-finite count', () => {
    expect(formatCount(Number.NaN, 'en')).toBe('0');
    expect(formatCount(Number.POSITIVE_INFINITY, 'tr')).toBe('0');
  });
});

describe('formatBytes', () => {
  it('renders zero bytes for anything unusable', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(-1, 'en')).toBe('0 B');
    expect(formatBytes(Number.NaN, 'tr')).toBe('0 B');
  });

  it('never shows a fraction of a byte', () => {
    expect(formatBytes(1, 'en')).toBe('1 B');
    expect(formatBytes(1_023, 'en')).toBe('1,023 B');
  });

  it('shows one decimal below ten of a unit and none above', () => {
    expect(formatBytes(1_024, 'en')).toBe('1 KB');
    expect(formatBytes(1_536, 'en')).toBe('1.5 KB');
    expect(formatBytes(10_240, 'en')).toBe('10 KB');
    expect(formatBytes(5 * 1024 ** 2, 'en')).toBe('5 MB');
  });

  it('uses the locale decimal separator', () => {
    expect(formatBytes(1_536, 'tr')).toBe('1,5 KB');
  });

  it('clamps at the largest known unit instead of inventing one', () => {
    expect(formatBytes(2 * 1024 ** 5, 'en')).toBe('2 PB');
    expect(formatBytes(1024 ** 7, 'en')).toBe('1,048,576 PB');
  });
});

describe('formatRelative', () => {
  const NOW = new Date('2024-06-15T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses anything inside 45 seconds to "now"', () => {
    expect(formatRelative(NOW, 'tr')).toBe('şimdi');
    expect(formatRelative(NOW - 44_999, 'en')).toBe('just now');
    expect(formatRelative(NOW + 44_999, 'tr')).toBe('şimdi');
  });

  it('switches to seconds exactly at the 45 second boundary', () => {
    expect(formatRelative(NOW - 45_000, 'en')).toBe('45 sec. ago');
  });

  it('picks the largest unit that fits', () => {
    expect(formatRelative(NOW - 180_000, 'en')).toBe('3 min. ago');
    expect(formatRelative(NOW - 5 * 3_600_000, 'en')).toBe('5 hr. ago');
    expect(formatRelative(NOW - 2 * 31_536_000_000, 'en')).toBe('2 yr. ago');
    expect(formatRelative(NOW - 180_000, 'tr')).toBe('3 dk. önce');
    expect(formatRelative(NOW - 5 * 3_600_000, 'tr')).toBe('5 sa. önce');
  });

  it('renders a future timestamp in the other direction', () => {
    expect(formatRelative(NOW + 180_000, 'en')).toBe('in 3 min.');
    expect(formatRelative(NOW + 180_000, 'tr')).toBe('3 dk. sonra');
  });

  it('returns an empty string for a non-finite timestamp', () => {
    expect(formatRelative(Number.NaN, 'en')).toBe('');
    expect(formatRelative(Number.POSITIVE_INFINITY, 'tr')).toBe('');
  });
});

describe('formatReleaseYear', () => {
  it('pulls the year out of a full ISO date', () => {
    expect(formatReleaseYear('2024-03-12')).toBe('2024');
    expect(formatReleaseYear('2024-03-12T10:00:00Z')).toBe('2024');
  });

  it('passes a bare year through', () => {
    expect(formatReleaseYear('2024')).toBe('2024');
  });

  it('finds the year anywhere in a free-form date', () => {
    expect(formatReleaseYear('12 Mart 2024')).toBe('2024');
  });

  it('returns an empty string when there is no four-digit run', () => {
    expect(formatReleaseYear(undefined)).toBe('');
    expect(formatReleaseYear('')).toBe('');
    expect(formatReleaseYear('unknown')).toBe('');
    expect(formatReleaseYear('199')).toBe('');
  });
});

describe('formatTrackPosition', () => {
  it('shows the track number alone on a single-disc release', () => {
    expect(formatTrackPosition(undefined, 5)).toBe('5');
    expect(formatTrackPosition(1, 5)).toBe('5');
    expect(formatTrackPosition(0, 5)).toBe('5');
  });

  it('prefixes the disc once a second disc is in play', () => {
    expect(formatTrackPosition(2, 5)).toBe('2-5');
    expect(formatTrackPosition(3, 12)).toBe('3-12');
  });

  it('truncates fractional positions', () => {
    expect(formatTrackPosition(3.9, 7.2)).toBe('3-7');
  });

  it('renders nothing without a usable track number', () => {
    expect(formatTrackPosition(2, undefined)).toBe('');
    expect(formatTrackPosition(undefined, undefined)).toBe('');
    expect(formatTrackPosition(2, 0)).toBe('');
    expect(formatTrackPosition(2, -1)).toBe('');
    expect(formatTrackPosition(2, Number.NaN)).toBe('');
  });
});

describe('formatBitrate', () => {
  it('rounds to a whole kbps', () => {
    expect(formatBitrate(320)).toBe('320 kbps');
    expect(formatBitrate(128.6)).toBe('129 kbps');
  });

  it('renders nothing for a missing or meaningless bitrate', () => {
    expect(formatBitrate(undefined)).toBe('');
    expect(formatBitrate(0)).toBe('');
    expect(formatBitrate(-1)).toBe('');
    expect(formatBitrate(Number.NaN)).toBe('');
  });
});
