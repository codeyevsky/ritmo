import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatBitrate, formatCount, makeUri, parseUri, stationToTrack } from '@ritmo/core';
import type { Lang, Shelf, Station, Uri } from '@ritmo/core';

import { Badge, Card, EmptyState, ErrorBanner, Select, Skeleton } from '../components';
import type { MenuItemSpec } from '../components';
import { useAsync, useTranslation } from '../hooks';
import type { TFunction } from '../hooks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore, useSettingsStore } from '../store';
import { ExternalLink as IconExternalLink, Heart as IconHeart, HeartFilled as IconHeartFilled, Plus as IconPlus, Radio } from '../icons';

const ALL = 'all';
const HOME_COUNTRY = 'TR';
const MAX_STATIONS = 60;
const GRID_CLASS = 'flex flex-wrap gap-4';

export function RadioView(): ReactElement {
  const { registry, controller, host } = useServices();
  const { t, lang } = useTranslation();
  const navigate = useNavigate();

  const radioEnabled = useSettingsStore((s) => s.settings.enabledProviders.includes('radio'));
  const currentUri = usePlayerStore((s) => s.current?.uri);
  const isPlaying = usePlayerStore((s) => s.status === 'playing');
  const liveName = usePlayerStore((s) => (s.current?.isLive ? s.current.title : undefined));
  const streamTitle = usePlayerStore((s) =>
    s.current?.isLive ? metaString(s.current.meta, 'streamTitle') : undefined,
  );

  const likedUris = useLibraryStore((st) => st.likedUris);
  const toggleLike = useLibraryStore((st) => st.toggleLike);

  const menuFor = useCallback(
    (station: Station): MenuItemSpec[] => {
      const trackUri = liveTrackUri(station.uri);
      const track = stationToTrack(station);
      return [
        {
          id: 'like',
          label: likedUris.has(trackUri) ? t('player.unlike') : t('player.like'),
          icon: likedUris.has(trackUri) ? IconHeartFilled : IconHeart,
          onSelect: () => void toggleLike(track),
        },
        {
          id: 'queue',
          label: t('queue.addToQueue'),
          icon: IconPlus,
          onSelect: () => controller.getQueue() && void controller.playTrack(track),
        },
        {
          id: 'homepage',
          label: t('common.share'),
          icon: IconExternalLink,
          disabled: !station.homepage,
          onSelect: () => {
            if (station.homepage) void host.openExternal(station.homepage);
          },
        },
      ];
    },
    [controller, host, likedUris, t, toggleLike],
  );

  const [country, setCountry] = useState<string>(HOME_COUNTRY);

  const directory = useAsync<Shelf[]>(
    async () => {
      const provider = registry.require('radio');
      return (await provider.getShelves?.()) ?? [];
    },
    [registry, radioEnabled],
    { keepPrevious: true, enabled: radioEnabled },
  );

  const stations = useMemo(() => collectStations(directory.data ?? []), [directory.data]);

  useEffect(() => {
    document.title = `${t('nav.radio')} • Ritmo`;
  }, [t]);

  // Turkey is the intended default, but a mirror with no Turkish stations must
  // not leave the grid empty.
  useEffect(() => {
    if (directory.loading || country !== HOME_COUNTRY || stations.length === 0) return;
    if (!stations.some((station) => station.country === HOME_COUNTRY)) setCountry(ALL);
  }, [country, directory.loading, stations]);


  const countries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const station of stations) {
      if (!station.country) continue;
      counts.set(station.country, (counts.get(station.country) ?? 0) + 1);
    }
    const rest = [...counts.entries()]
      .filter(([code]) => code !== HOME_COUNTRY)
      .sort((a, b) => b[1] - a[1])
      .map(([code]) => code);
    // "All" first — it is the escape hatch when a mirror has nothing for the
    // selected country — then Turkey, then whatever the directory actually
    // carries, most-stations first.
    return [ALL, HOME_COUNTRY, ...rest].map((code) => ({
      value: code,
      label: code === ALL ? t('common.all') : `${flagOf(code)} ${regionName(code, lang)}`,
    }));
  }, [lang, stations, t]);

  const visible = useMemo(() => {
    const matching = stations.filter((station) => {
      return country === ALL || station.country === country;
    });
    return [...matching].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0)).slice(0, MAX_STATIONS);
  }, [country, stations]);

  const play = useCallback(
    (station: Station) => {
      const track = stationToTrack(station);
      if (track.uri === currentUri) {
        void controller.toggle();
        return;
      }
      void controller.playTrack(track, 'user').catch(() => undefined);
    },
    [controller, currentUri],
  );

  const resetFilters = useCallback(() => {
    setCountry(ALL);
  }, []);

  const failureCode = errorCode(directory.error);

  if (!radioEnabled || failureCode === 'unsupported') {
    return (
      <div className="mx-auto flex w-full max-w-[1400px] flex-col px-4 pb-16 pt-10 sm:px-6">
        <EmptyState
          icon={Radio}
          title={t('radio.disabledTitle')}
          body={t('radio.disabledBody')}
          action={{ label: t('settings.sources'), onClick: () => navigate('/settings/sources') }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-6">
      {liveName && (
        <div className="flex flex-wrap items-center gap-3 rounded-sm border border-line px-4 py-2.5">
          <Badge tone="accent">{t('radio.live')}</Badge>
          <span className="min-w-0 truncate text-sm text-text">{liveName}</span>
          {streamTitle && (
            <span aria-live="polite" className="min-w-0 truncate text-sm text-text-dim">
              {streamTitle}
            </span>
          )}
        </div>
      )}

      <h1 className="text-2xl font-semibold tracking-tight text-text">{t('nav.radio')}</h1>

      {directory.error && failureCode !== 'unsupported' && (
        <ErrorBanner
          title={
            failureCode === 'auth'
              ? t('errors.providerAuth', { provider: 'Radio' })
              : t('errors.network')
          }
          onRetry={directory.reload}
        />
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {directory.loading ? t('common.loading') : ''}
      </p>

      <section
        aria-labelledby="radio-top"
        aria-busy={directory.loading}
        className="flex flex-col gap-4"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 id="radio-top" className="rule-label min-w-0 flex-1">
            <span className="min-w-0 truncate">{t('radio.topVoted')}</span>
          </h2>
          <div className="shrink-0">
            <Select
              value={country}
              options={countries}
              onChange={setCountry}
              label={t('radio.country')}
              size="sm"
            />
          </div>
        </div>

        {directory.loading && visible.length === 0 ? (
          <div className={GRID_CLASS} aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={`station-skeleton-${i}`} className="h-[250px] w-[204px]" rounded="md" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Radio}
            title={t('radio.emptyTitle')}
            body={t('radio.emptyBody')}
            action={{ label: t('common.all'), onClick: resetFilters }}
            {...(directory.error ? { secondaryAction: { label: t('settings.retry'), onClick: directory.reload } } : {})}
          />
        ) : (
          <div className={GRID_CLASS}>
            {visible.map((station) => (
              <Card
                key={station.uri}
                kind="station"
                uri={station.uri}
                title={station.name}
                subtitle={stationSubtitle(station, lang, t)}
                artwork={station.artwork}
                playing={isPlaying && liveTrackUri(station.uri) === currentUri}
                onOpen={() => play(station)}
                onPlay={() => play(station)}
                menuItems={menuFor(station)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function collectStations(shelves: Shelf[]): Station[] {
  const out: Station[] = [];
  const seen = new Set<Uri>();
  for (const shelf of shelves) {
    for (const item of shelf.items) {
      if (item.type !== 'station' || seen.has(item.station.uri)) continue;
      seen.add(item.station.uri);
      out.push(item.station);
    }
  }
  return out;
}

function stationSubtitle(station: Station, lang: Lang, t: TFunction): string {
  const parts: string[] = [];
  if (station.codec) parts.push(station.codec);
  if (station.bitrate) parts.push(formatBitrate(station.bitrate));
  if (station.votes !== undefined) {
    parts.push(t('radio.votes', { count: formatCount(station.votes, lang) }));
  }
  return parts.join(' · ');
}

/** Station and live-track Uris share the uuid; only the track form ever plays. */
function liveTrackUri(stationUri: Uri): Uri {
  try {
    return makeUri('radio', 'track', parseUri(stationUri).id);
  } catch {
    return stationUri;
  }
}

/**
 * Region names are data rather than interface copy, so they come from the
 * platform — with the raw code as the fallback where Intl has no entry.
 */
function regionName(code: string, lang: Lang): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * ISO 3166-1 alpha-2 maps onto the regional-indicator block, so a flag needs no
 * asset and no lookup table. Anything that is not two ASCII letters (the
 * directory does carry the odd bad code) yields an empty string rather than
 * two stray glyphs.
 */
function flagOf(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  const base = 0x1f1e6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(...[...code.toUpperCase()].map((ch) => base + ch.charCodeAt(0)));
}

/** A ProviderError that crossed a bundle boundary fails `instanceof`. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!meta) return undefined;
  const value = meta[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}
