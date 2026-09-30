import { useCallback, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { uriProvider } from '@ritmo/core';
import type { Track, TrackDetailsPatch, Uri } from '@ritmo/core';

import { Button } from '../components/Button';
import { ErrorBanner } from '../components/ErrorBanner';
import { Input } from '../components/Input';
import { Modal } from '../components/Modal';
import type { MenuItemSpec } from '../components/DropdownMenu';
import { useToast } from '../hooks/useToast';
import { useTranslation } from '../hooks/useTranslation';
import type { TFunction } from '../hooks/useTranslation';
import { Edit } from '../icons';
import { useServices } from '../services';
import { useLibraryStore } from '../store/library';

/** A 4-digit year, or an ISO date narrowed down to year-month or the full day. */
const YEAR_OR_ISO = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const POSITIVE_INT = /^\d+$/;

type Field = 'title' | 'artists' | 'album' | 'year' | 'genres' | 'trackNo' | 'discNo';
type Draft = Record<Field, string>;
type Errors = Partial<Record<Field, string>>;

export interface TrackDetailsEditor {
  /** The menu entry; empty for anything that is not a `local:` track. */
  itemsFor: (track: Track) => MenuItemSpec[];
  /** Applies saved edits to a list so the row refreshes without a refetch. */
  applyEdits: (tracks: Track[]) => Track[];
  /** Must be rendered by the consumer, or the menu entry opens nothing. */
  dialog: ReactElement;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function toDraft(track: Track): Draft {
  return {
    title: track.title,
    artists: track.artists.map((artist) => artist.name).join(', '),
    album: track.album?.name ?? '',
    year: track.releaseDate ?? '',
    genres: (track.genres ?? []).join(', '),
    trackNo: track.trackNumber === undefined ? '' : String(track.trackNumber),
    discNo: track.discNumber === undefined ? '' : String(track.discNumber),
  };
}

function validate(draft: Draft, t: TFunction): Errors {
  const errors: Errors = {};
  if (draft.title.trim().length === 0) errors.title = t('track.errTitle');
  const year = draft.year.trim();
  if (year.length > 0 && !YEAR_OR_ISO.test(year)) errors.year = t('track.errYear');
  for (const field of ['trackNo', 'discNo'] as const) {
    const raw = draft[field].trim();
    if (raw.length === 0) continue;
    if (!POSITIVE_INT.test(raw) || Number(raw) < 1) errors[field] = t('track.errNumber');
  }
  return errors;
}

/**
 * Only the fields the user actually touched travel to the repo: it records the
 * edited columns so a later rescan cannot undo them, and an untouched field
 * must not be marked as hand-edited.
 */
function diff(before: Draft, after: Draft): TrackDetailsPatch {
  const patch: TrackDetailsPatch = {};
  if (after.title !== before.title) patch.title = after.title.trim();
  if (after.artists !== before.artists) patch.artists = splitList(after.artists);
  if (after.album !== before.album) patch.albumName = after.album.trim();
  if (after.year !== before.year) patch.releaseDate = after.year.trim();
  if (after.genres !== before.genres) patch.genres = splitList(after.genres);
  // An emptied number is left out rather than sent: the repo treats `undefined`
  // as "unchanged", so there is no way to clear one from here.
  if (after.trackNo !== before.trackNo && after.trackNo.trim().length > 0) {
    patch.trackNumber = Number(after.trackNo.trim());
  }
  if (after.discNo !== before.discNo && after.discNo.trim().length > 0) {
    patch.discNumber = Number(after.discNo.trim());
  }
  return patch;
}

/**
 * The "Edit details" row menu entry plus the dialog behind it. Edits are stored
 * in Ritmo's database only — nothing is ever written back to the file's tags.
 */
export function useTrackDetailsEditor(): TrackDetailsEditor {
  const { library } = useServices();
  const { t } = useTranslation();
  const { show } = useToast();
  const refreshStats = useLibraryStore((s) => s.refreshStats);
  const uid = useId();

  const [track, setTrack] = useState<Track | undefined>(undefined);
  const [before, setBefore] = useState<Draft | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [errors, setErrors] = useState<Errors>({});
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [edited, setEdited] = useState<Map<Uri, Track>>(() => new Map());

  const repo = library.repo;

  const close = useCallback(() => {
    if (saving) return;
    setTrack(undefined);
    setBefore(undefined);
    setDraft(undefined);
    setErrors({});
    setSaveError(undefined);
  }, [saving]);

  const open = useCallback(
    (row: Track) => {
      const current = edited.get(row.uri) ?? row;
      const initial = toDraft(current);
      setTrack(current);
      setBefore(initial);
      setDraft(initial);
      setErrors({});
      setSaveError(undefined);
    },
    [edited],
  );

  const set = useCallback((field: Field, value: string) => {
    setDraft((prev) => (prev === undefined ? prev : { ...prev, [field]: value }));
    setErrors((prev) => (prev[field] === undefined ? prev : { ...prev, [field]: undefined }));
  }, []);

  const save = useCallback(() => {
    if (track === undefined || draft === undefined || before === undefined) return;

    const found = validate(draft, t);
    if (Object.values(found).some((message) => message !== undefined)) {
      setErrors(found);
      return;
    }

    const patch = diff(before, draft);
    if (Object.keys(patch).length === 0) {
      show({ title: t('track.noChanges') });
      close();
      return;
    }

    setSaving(true);
    setSaveError(undefined);
    void (async () => {
      try {
        await repo.updateTrackDetails(track.uri, patch);
        const updated = await repo.getTrack(track.uri);
        if (updated !== undefined) {
          setEdited((prev) => new Map(prev).set(updated.uri, updated));
        }
        show({ title: t('track.saved'), tone: 'success' });
        // Renaming an album or an artist moves the track between groupings.
        void refreshStats();
        setTrack(undefined);
        setBefore(undefined);
        setDraft(undefined);
      } catch (e: unknown) {
        setSaveError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    })();
  }, [track, draft, before, t, show, close, repo, refreshStats]);

  const itemsFor = useCallback(
    (row: Track): MenuItemSpec[] =>
      uriProvider(row.uri) === 'local'
        ? [
            {
              id: 'edit-details',
              label: t('track.editDetails'),
              icon: Edit,
              separatorBefore: true,
              onSelect: () => open(row),
            },
          ]
        : [],
    [t, open],
  );

  const applyEdits = useCallback(
    (list: Track[]): Track[] =>
      edited.size === 0 ? list : list.map((row) => edited.get(row.uri) ?? row),
    [edited],
  );

  const field = (
    name: Field,
    label: string,
    extra?: { hint?: string; placeholder?: string; autoFocus?: boolean; inputMode?: 'numeric' },
  ): ReactNode => {
    const id = `${uid}-${name}`;
    const error = errors[name];
    const hintId = extra?.hint === undefined ? undefined : `${id}-hint`;
    const errorId = error === undefined ? undefined : `${id}-error`;
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={id} className="text-xs font-medium text-text-dim">
          {label}
        </label>
        <Input
          id={id}
          value={draft?.[name] ?? ''}
          onChange={(e) => set(name, e.target.value)}
          invalid={error !== undefined}
          aria-describedby={[errorId, hintId].filter((v): v is string => v !== undefined).join(' ') || undefined}
          placeholder={extra?.placeholder}
          autoFocus={extra?.autoFocus}
          inputMode={extra?.inputMode}
          disabled={saving}
        />
        {error !== undefined ? (
          <p id={errorId} role="alert" className="text-xs leading-5 text-danger">
            {error}
          </p>
        ) : extra?.hint !== undefined ? (
          <p id={hintId} className="text-xs leading-5 text-text-faint">
            {extra.hint}
          </p>
        ) : null}
      </div>
    );
  };

  const dialog = (
    <Modal
      open={track !== undefined}
      onClose={close}
      dismissible={!saving}
      title={t('track.editTitle')}
      description={t('track.editHint')}
      size="lg"
      actions={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {saveError !== undefined ? (
          <ErrorBanner
            title={t('track.saveFailed')}
            body={saveError}
            tone="danger"
            onDismiss={() => setSaveError(undefined)}
          />
        ) : null}

        {field('title', t('track.fieldTitle'), { autoFocus: true })}
        {field('artists', t('track.fieldArtists'), { hint: t('track.fieldArtistsHint') })}
        {field('album', t('track.fieldAlbum'))}

        <div className="grid gap-4 sm:grid-cols-3">
          {field('year', t('track.fieldYear'), { hint: t('track.fieldYearHint') })}
          {field('trackNo', t('track.fieldTrackNo'), { inputMode: 'numeric' })}
          {field('discNo', t('track.fieldDiscNo'), { inputMode: 'numeric' })}
        </div>

        {field('genres', t('track.fieldGenres'), { hint: t('track.fieldGenresHint') })}
      </div>
    </Modal>
  );

  return { itemsFor, applyEdits, dialog };
}
