import { useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import clsx from 'clsx';
import {
  formatBitrate,
  formatBytes,
  formatDate,
  formatDuration,
  uriProvider,
} from '@ritmo/core';
import type { Lang, Track, TrackFile, Uri } from '@ritmo/core';

import { IconButton } from '../components/IconButton';
import { Modal } from '../components/Modal';
import { ProviderBadge } from '../components/ProviderBadge';
import type { MenuItemSpec } from '../components/DropdownMenu';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useTranslation } from '../hooks/useTranslation';
import type { TFunction } from '../hooks/useTranslation';
import { Copy, Info } from '../icons';
import { useServices } from '../services';
import { useSettingsStore } from '../store/settings';

// ── paths ───────────────────────────────────────────────────────────────────

/** Both separators are accepted: a path is whatever the platform handed over. */
const TRAILING_SEPARATORS = /[\\/]+$/;

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/** The containing folder, or `undefined` when the path has no folder part. */
export function folderOf(path: string): string | undefined {
  const cut = lastSeparator(path);
  return cut > 0 ? path.slice(0, cut) : undefined;
}

/** Lower case extension without the dot, when the file name carries one. */
function extensionOf(path: string): string | undefined {
  const name = path.slice(lastSeparator(path) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * True when `folder` is one of the scanned roots or sits inside one. Trailing
 * separators are trimmed so `/music` and `/music/` behave the same.
 */
export function isScannedFolder(folder: string, roots: readonly string[]): boolean {
  const target = folder.replace(TRAILING_SEPARATORS, '');
  if (target.length === 0) return false;
  return roots.some((raw) => {
    const root = raw.replace(TRAILING_SEPARATORS, '');
    return (
      root.length > 0 &&
      (target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`))
    );
  });
}

/**
 * Whether a removed file would come straight back: this is the one rule the
 * removal toast and the Details surfaces both answer with.
 */
export function isScannedPath(path: string | undefined, roots: readonly string[]): boolean {
  if (path === undefined || path.length === 0) return false;
  const folder = folderOf(path);
  return folder !== undefined && isScannedFolder(folder, roots);
}

// ── meta_json ───────────────────────────────────────────────────────────────

/** `meta` is free-form provider payload, so every read narrows rather than casts. */
function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = meta?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function metaText(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

// ── rows ────────────────────────────────────────────────────────────────────

interface Fact {
  id: string;
  label: string;
  value: ReactNode;
  /** Numbers, paths and identifiers; prose stays in the text face. */
  mono?: boolean;
}

/**
 * A fact with nothing behind it is left out rather than rendered blank: an
 * empty row claims the field exists and says nothing about it.
 */
function FactList({ facts }: { facts: Fact[] }): ReactElement {
  return (
    <dl className="flex min-w-0 flex-col gap-3">
      {facts.map((fact) => (
        <div
          key={fact.id}
          className="grid min-w-0 gap-0.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3"
        >
          <dt className="min-w-0 text-[11px] font-medium uppercase tracking-[0.08em] text-text-faint sm:truncate sm:pt-0.5">
            {fact.label}
          </dt>
          <dd
            className={clsx(
              'min-w-0 text-[13px] leading-snug text-text',
              fact.mono === true && 'mono',
            )}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A path or a uri: selectable because the body is `user-select: none`. */
function Copyable({ text, label }: { text: string; label: string }): ReactElement {
  const { t } = useTranslation();
  const { show } = useToast();

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => show({ title: t('common.copied'), tone: 'success' }))
      .catch(() => show({ title: t('errors.copyFailed'), tone: 'danger' }));
  }, [show, t, text]);

  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <span className="selectable mono min-w-0 flex-1 break-all">{text}</span>
      <IconButton icon={Copy} label={label} size="xs" className="shrink-0" onClick={copy} />
    </span>
  );
}

// ── fact builders ───────────────────────────────────────────────────────────

function localFacts(
  track: Track,
  file: TrackFile | undefined,
  roots: readonly string[],
  t: TFunction,
  lang: Lang,
): Fact[] {
  const facts: Fact[] = [];
  const path = file?.path ?? track.path;

  if (path !== undefined) {
    facts.push({
      id: 'file',
      label: t('details.file'),
      value: <Copyable text={path} label={t('details.copyPath')} />,
    });
    const folder = folderOf(path);
    if (folder !== undefined) {
      facts.push({
        id: 'folder',
        label: t('details.folder'),
        value: <span className="selectable break-all">{folder}</span>,
        mono: true,
      });
    }
    // The decisive fact after a removal, which is why it is spelled out here
    // rather than left for the user to work out from Settings.
    facts.push({
      id: 'rescan',
      label: t('details.rescan'),
      value: isScannedPath(path, roots)
        ? t('details.scannedHint')
        : t('details.notScannedHint'),
    });
    const extension = extensionOf(path);
    if (extension !== undefined) {
      facts.push({
        id: 'format',
        label: t('details.format'),
        value: extension.toUpperCase(),
        mono: true,
      });
    }
  }

  if (file?.sizeBytes !== undefined) {
    facts.push({
      id: 'size',
      label: t('details.size'),
      value: formatBytes(file.sizeBytes, lang),
      mono: true,
    });
  }
  if (file?.modifiedAt !== undefined) {
    facts.push({
      id: 'modified',
      label: t('details.modified'),
      value: formatDate(file.modifiedAt, lang),
    });
  }
  if (file?.addedAt !== undefined) {
    facts.push({ id: 'added', label: t('details.added'), value: formatDate(file.addedAt, lang) });
  }
  if (track.durationMs > 0) {
    facts.push({
      id: 'length',
      label: t('details.length'),
      value: formatDuration(track.durationMs),
      mono: true,
    });
  }

  const bitrate = formatBitrate(metaNumber(track.meta, 'bitrate'));
  if (bitrate !== '') {
    facts.push({ id: 'bitrate', label: t('details.bitrate'), value: bitrate, mono: true });
  }
  const sampleRate = metaNumber(track.meta, 'sampleRate');
  if (sampleRate !== undefined) {
    facts.push({
      id: 'sampleRate',
      label: t('details.sampleRate'),
      value: t('details.hertz', { value: sampleRate }),
      mono: true,
    });
  }
  const channels = metaNumber(track.meta, 'channels');
  if (channels !== undefined) {
    facts.push({
      id: 'channels',
      label: t('details.channels'),
      value: String(channels),
      mono: true,
    });
  }
  // Gain is legitimately zero or negative, so only finiteness rules it out.
  if (track.gainDb !== undefined && Number.isFinite(track.gainDb)) {
    facts.push({
      id: 'gain',
      label: t('details.gain'),
      value: t('details.decibels', { value: track.gainDb.toFixed(1) }),
      mono: true,
    });
  }

  return facts;
}

function remoteFacts(track: Track, t: TFunction): Fact[] {
  const facts: Fact[] = [
    {
      id: 'source',
      label: t('details.source'),
      value: <ProviderBadge provider={track.provider} size="md" />,
    },
    {
      id: 'link',
      label: t('details.link'),
      value: <Copyable text={track.uri} label={t('details.copyUri')} />,
    },
  ];

  if (track.durationMs > 0) {
    facts.push({
      id: 'length',
      label: t('details.length'),
      value: formatDuration(track.durationMs),
      mono: true,
    });
  }
  const released = track.releaseDate?.trim();
  if (released !== undefined && released.length > 0) {
    facts.push({ id: 'released', label: t('details.released'), value: released, mono: true });
  }
  const genres = (track.genres ?? []).map((genre) => genre.trim()).filter((genre) => genre !== '');
  if (genres.length > 0) {
    facts.push({ id: 'genres', label: t('details.genres'), value: genres.join(' · ') });
  }
  // Only the Creative Commons providers hand one over; Jamendo always does.
  const license = metaText(track.meta, 'license');
  if (license !== undefined) {
    facts.push({
      id: 'license',
      label: t('details.license'),
      value: <span className="selectable mono break-all">{license}</span>,
    });
  }

  return facts;
}

// ── track details ───────────────────────────────────────────────────────────

export interface TrackDetailsViewer {
  /** The row menu entry for one track, for both the overflow and the context menu. */
  itemsFor: (track: Track) => MenuItemSpec[];
  /** Must be rendered by the consumer, or the menu entry opens nothing. */
  dialog: ReactElement;
}

/**
 * "Details" as a row menu entry plus the dialog behind it.
 *
 * It reads and shows, nothing else: a question about where one track's file
 * lives is answered at the track, not by sending the user to a configuration
 * screen that knows only about folders.
 */
export function useTrackDetails(): TrackDetailsViewer {
  const { library } = useServices();
  const { t, lang } = useTranslation();
  const roots = useSettingsStore((s) => s.settings.musicFolders);
  const [track, setTrack] = useState<Track | undefined>(undefined);

  const repo = library.repo;
  const uri: Uri | undefined = track?.uri;
  const local = uri !== undefined && uriProvider(uri) === 'local';

  // The file stamps are not on `Track`, so the row is read while the dialog is
  // open; a remote track has none and never asks.
  const load = useCallback(
    () => (uri === undefined ? Promise.resolve<TrackFile[]>([]) : repo.getTrackFiles([uri])),
    [repo, uri],
  );
  const files = useAsync(load, [load], { enabled: local });
  const file = files.data?.[0];

  const facts = useMemo(() => {
    if (track === undefined) return [];
    return local ? localFacts(track, file, roots, t, lang) : remoteFacts(track, t);
  }, [file, lang, local, roots, t, track]);

  // An untitled row would otherwise put an empty line in the dialog header.
  const title = track?.title.trim() ?? '';
  const described =
    track === undefined ? undefined : title.length > 0 ? title : t('details.hint');

  const itemsFor = useCallback(
    (row: Track): MenuItemSpec[] => [
      {
        id: 'details',
        label: t('details.title'),
        icon: Info,
        separatorBefore: true,
        onSelect: () => setTrack(row),
      },
    ],
    [t],
  );

  const dialog = (
    <Modal
      open={track !== undefined}
      onClose={() => setTrack(undefined)}
      size="md"
      title={t('details.trackTitle')}
      description={described}
    >
      {facts.length === 0 ? (
        <p className="text-[13px] leading-snug text-text-dim">{t('details.empty')}</p>
      ) : (
        <FactList facts={facts} />
      )}
    </Modal>
  );

  return { itemsFor, dialog };
}

// ── album details ───────────────────────────────────────────────────────────

interface FolderSummary {
  folder: string;
  files: number;
  bytes: number;
  scanned: boolean;
}

/** The dictionary has no plural machinery, so one file gets its own string. */
function fileCount(count: number, t: TFunction): string {
  return count === 1 ? t('details.fileOne') : t('details.fileCount', { count });
}

export interface AlbumDetailsProps {
  /** The album's stored tracks; staged, unsaved ones have no file yet. */
  tracks: Track[];
}

/**
 * Where a local album's files live, on the album page itself. Folders belong
 * next to the music they hold, not in Settings.
 *
 * Renders nothing at all when no path is stored: a heading over an empty tile
 * is worse than no section.
 */
export function AlbumDetails({ tracks }: AlbumDetailsProps): ReactElement | null {
  const { library } = useServices();
  const { t, lang } = useTranslation();
  const roots = useSettingsStore((s) => s.settings.musicFolders);
  const repo = library.repo;

  const uris = useMemo(
    () => tracks.filter((track) => uriProvider(track.uri) === 'local').map((track) => track.uri),
    [tracks],
  );

  const load = useCallback(() => repo.getTrackFiles(uris), [repo, uris]);
  const files = useAsync(load, [load], { enabled: uris.length > 0, keepPrevious: true });

  const summary = useMemo(() => {
    const byFolder = new Map<string, { files: number; bytes: number }>();
    let count = 0;
    let bytes = 0;
    for (const file of files.data ?? []) {
      const path = file.path;
      if (path === undefined) continue;
      const size = file.sizeBytes ?? 0;
      count += 1;
      bytes += size;
      // A file with no folder part is listed under its own name rather than
      // dropped: it is still one of the album's files.
      const folder = folderOf(path) ?? path;
      const entry = byFolder.get(folder) ?? { files: 0, bytes: 0 };
      byFolder.set(folder, { files: entry.files + 1, bytes: entry.bytes + size });
    }
    const folders: FolderSummary[] = [...byFolder.entries()]
      .map(([folder, entry]) => ({
        folder,
        files: entry.files,
        bytes: entry.bytes,
        scanned: isScannedFolder(folder, roots),
      }))
      .sort((a, b) => a.folder.localeCompare(b.folder));
    return { count, bytes, folders };
  }, [files.data, roots]);

  if (summary.folders.length === 0) return null;

  const total = [
    fileCount(summary.count, t),
    summary.bytes > 0 ? formatBytes(summary.bytes, lang) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="rule-label">{t('details.title')}</h2>
      <div className="tile flex min-w-0 flex-col gap-3 rounded-md px-3 py-3">
        <p className="mono min-w-0 text-[12px] text-text-dim">{total}</p>
        <ul className="flex min-w-0 flex-col gap-2.5">
          {summary.folders.map((group) => (
            <li key={group.folder} className="flex min-w-0 flex-col gap-0.5">
              <span className="selectable mono min-w-0 break-all text-[12px] text-text">
                {group.folder}
              </span>
              <span className="mono min-w-0 break-words text-[11px] text-text-faint">
                {[
                  fileCount(group.files, t),
                  group.bytes > 0 ? formatBytes(group.bytes, lang) : undefined,
                  group.scanned ? t('details.scanned') : t('details.notScanned'),
                ]
                  .filter((part): part is string => part !== undefined)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
