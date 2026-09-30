import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import clsx from 'clsx';
import type { Track, Uri } from '@ritmo/core';

import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { useTranslation } from '../hooks/useTranslation';
import { useServices } from '../services';
import { useLibraryStore } from '../store/library';

/** What "delete" is allowed to mean. Neither reading touches a file on disk. */
type DeleteMode = 'albumOnly' | 'withTracks';

export interface AlbumDeleter {
  /** Opens the confirmation for a local album and the tracks it holds. */
  request: (album: { uri: Uri; name: string }, tracks: Track[]) => void;
  /** Must be rendered by the consumer, or the confirmation opens nothing. */
  dialog: ReactElement;
}

interface Target {
  album: { uri: Uri; name: string };
  tracks: Track[];
}

/**
 * "Delete album" as a confirmation with a choice in it.
 *
 * An album is a grouping of tracks, so deleting one can reasonably mean either
 * "lose the grouping" or "lose the music", and the two are far enough apart
 * that guessing is not an option. Files on disk are never touched either way,
 * which is why the dialog says so.
 */
export function useDeleteAlbum(onDeleted: () => void): AlbumDeleter {
  const { library } = useServices();
  const { t } = useTranslation();
  const { show } = useToast();

  const [target, setTarget] = useState<Target | undefined>(undefined);
  const [mode, setMode] = useState<DeleteMode>('albumOnly');
  const [busy, setBusy] = useState(false);

  const request = useCallback((album: { uri: Uri; name: string }, tracks: Track[]) => {
    setTarget({ album, tracks });
    setMode('albumOnly');
  }, []);

  const close = useCallback(() => {
    if (!busy) setTarget(undefined);
  }, [busy]);

  const confirm = useCallback(() => {
    if (target === undefined || busy) return;
    const { album, tracks } = target;
    setBusy(true);
    void (async () => {
      try {
        const uris = tracks.map((track) => track.uri);
        if (mode === 'withTracks') {
          // One commit that also clears their likes and their place in every
          // playlist and pack.
          await library.repo.removeTracks(uris);
        } else {
          for (const trackUri of uris) await library.repo.setTrackAlbum(trackUri, undefined);
        }
        // A liked album survives the orphan sweep on purpose, so the like has
        // to go first or the row the user just deleted would stay behind.
        await library.likes.unlike(album.uri);
        await library.repo.vacuumOrphans();
        await useLibraryStore.getState().invalidate();
        setTarget(undefined);
        show({ title: t('album.deleteAlbumDone'), tone: 'success' });
        onDeleted();
      } catch (e: unknown) {
        show({
          title: t('album.deleteAlbumFailed'),
          body: e instanceof Error ? e.message : undefined,
          tone: 'danger',
          durationMs: 6000,
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, library, mode, onDeleted, show, t, target]);

  const options: Array<{ id: DeleteMode; label: string; description: string }> = [
    {
      id: 'albumOnly',
      label: t('album.deleteAlbumOnly'),
      description: t('album.deleteAlbumOnlyDesc'),
    },
    {
      id: 'withTracks',
      label: t('album.deleteAlbumWithTracks'),
      description: t('album.deleteAlbumWithTracksDesc'),
    },
  ];

  const dialog = (
    <Modal
      open={target !== undefined}
      onClose={close}
      dismissible={!busy}
      size="sm"
      title={t('album.deleteAlbumTitle', { name: target?.album.name ?? '' })}
      description={t('album.deleteAlbumBody')}
      actions={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={confirm}>
            {t('album.deleteAlbum')}
          </Button>
        </>
      }
    >
      <div
        role="radiogroup"
        aria-label={t('album.deleteAlbumChoice')}
        className="flex min-w-0 flex-col gap-2"
      >
        {options.map((option) => {
          const active = mode === option.id;
          return (
            <label key={option.id} className="group min-w-0 cursor-pointer">
              <input
                type="radio"
                name="ritmo-delete-album"
                className="peer sr-only"
                value={option.id}
                checked={active}
                disabled={busy}
                onChange={() => setMode(option.id)}
              />
              <span
                className={clsx(
                  'block min-w-0 rounded-md border px-3 py-2 transition-colors duration-150 ease-swift',
                  'peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                  active ? 'border-accent bg-surface-2' : 'border-line group-hover:border-text-faint',
                )}
              >
                <span
                  className={clsx(
                    'block min-w-0 truncate text-[13px] font-medium',
                    active ? 'text-text' : 'text-text-dim',
                  )}
                >
                  {option.label}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-text-dim">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </Modal>
  );

  return { request, dialog };
}
