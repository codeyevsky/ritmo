import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { uriProvider } from '@ritmo/core';
import type { Track, Uri } from '@ritmo/core';

import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import type { MenuItemSpec } from '../components/DropdownMenu';
import { useToast } from '../hooks/useToast';
import { useTranslation } from '../hooks/useTranslation';
import { IconTrash } from '../icons';
import { useServices } from '../services';
import { useLibraryStore } from '../store/library';
import { useSettingsStore } from '../store/settings';

/** How many titles the confirmation lists before it starts counting instead. */
const NAMED_IN_CONFIRM = 8;
/** A toast carrying the rescan warning has something to read, so it lingers. */
const WARNING_TOAST_MS = 9000;

export interface LibraryRemover {
  /** The row menu entry for one track. */
  itemsFor: (track: Track) => MenuItemSpec[];
  /** Removes a selection; more than one track is confirmed first. */
  request: (tracks: Track[]) => void;
  /** Drops rows already removed, so a list settles without a refetch. */
  filterRemoved: (tracks: Track[]) => Track[];
  /** Must be rendered by the consumer, or the confirmation opens nothing. */
  dialog: ReactElement;
}

/**
 * A local file whose folder is still a scanned root comes straight back on the
 * next scan. Trailing separators are trimmed so `/music` and `/music/` behave
 * the same, and both separators are accepted because the setting holds whatever
 * the platform's folder picker handed over.
 */
function underScannedFolder(track: Track, folders: string[]): boolean {
  const path = track.path;
  if (path === undefined || path.length === 0) return false;
  return folders.some((folder) => {
    const root = folder.replace(/[\\/]+$/, '');
    return root.length > 0 && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`));
  });
}

/**
 * "Remove from library" as a row menu entry plus the confirmation behind it.
 *
 * Nothing here touches the filesystem: the track's rows leave Ritmo and the
 * file stays exactly where it is, which is why the wording says so and why a
 * local track still sitting under a scanned folder is called out afterwards.
 */
export function useRemoveFromLibrary(): LibraryRemover {
  const { library } = useServices();
  const { t } = useTranslation();
  const { show } = useToast();
  const navigate = useNavigate();
  const folders = useSettingsStore((s) => s.settings.musicFolders);

  const [pending, setPending] = useState<Track[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState<Set<Uri>>(() => new Set());

  const repo = library.repo;

  const remove = useCallback(
    (tracks: Track[]) => {
      const list = tracks.filter((track) => track.uri.length > 0);
      if (list.length === 0 || busy) return;
      setBusy(true);
      void (async () => {
        try {
          await repo.removeTracks(list.map((track) => track.uri));
          setGone((prev) => {
            const next = new Set(prev);
            for (const track of list) next.add(track.uri);
            return next;
          });
          // Counts, playlists, likes and downloads can all have shrunk.
          await useLibraryStore.getState().invalidate();

          const rescanned = list.some((track) => underScannedFolder(track, folders));
          show({
            title:
              list.length === 1
                ? t('track.removed')
                : t('track.removedCount', { count: list.length }),
            body: rescanned
              ? list.length === 1
                ? t('track.removedStillScanned')
                : t('track.removedStillScannedMany')
              : undefined,
            tone: 'success',
            durationMs: rescanned ? WARNING_TOAST_MS : undefined,
            action: rescanned
              ? {
                  label: t('track.openLibrarySettings'),
                  onClick: () => navigate('/settings/library'),
                }
              : undefined,
          });
          setPending(undefined);
        } catch (e: unknown) {
          // A write that failed has to say so; a console line would leave the
          // row on screen with no explanation for why it came back.
          show({
            title: t('track.removeFailed'),
            body: e instanceof Error ? e.message : undefined,
            tone: 'danger',
            durationMs: 6000,
          });
        } finally {
          setBusy(false);
        }
      })();
    },
    [busy, folders, navigate, repo, show, t],
  );

  const request = useCallback(
    (tracks: Track[]) => {
      // One track is a single undoable mistake; a selection is not, so it asks.
      if (tracks.length > 1) setPending(tracks);
      else remove(tracks);
    },
    [remove],
  );

  const itemsFor = useCallback(
    (track: Track): MenuItemSpec[] => [
      {
        id: 'remove-from-library',
        label:
          uriProvider(track.uri) === 'local'
            ? t('track.removeLocalFromLibrary')
            : t('track.removeFromLibrary'),
        icon: IconTrash,
        danger: true,
        separatorBefore: true,
        onSelect: () => request([track]),
      },
    ],
    [request, t],
  );

  const filterRemoved = useCallback(
    (tracks: Track[]): Track[] =>
      gone.size === 0 ? tracks : tracks.filter((track) => !gone.has(track.uri)),
    [gone],
  );

  const close = useCallback(() => {
    if (!busy) setPending(undefined);
  }, [busy]);

  const named = pending?.slice(0, NAMED_IN_CONFIRM) ?? [];
  const extra = (pending?.length ?? 0) - named.length;

  const dialog = (
    <Modal
      open={pending !== undefined}
      onClose={close}
      dismissible={!busy}
      size="sm"
      title={t('track.removeConfirmTitle', { count: pending?.length ?? 0 })}
      description={t('track.removeConfirmBody')}
      actions={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              if (pending !== undefined) remove(pending);
            }}
          >
            {t('common.remove')}
          </Button>
        </>
      }
    >
      <ul className="flex min-w-0 flex-col gap-1">
        {named.map((track) => (
          <li key={track.uri} className="min-w-0 truncate text-[13px] leading-6 text-text-dim">
            {track.title}
          </li>
        ))}
        {extra > 0 ? (
          <li className="mono min-w-0 truncate text-[11px] leading-6 text-text-faint">
            {t('track.removeConfirmMore', { count: extra })}
          </li>
        ) : null}
      </ul>
    </Modal>
  );

  return { itemsFor, request, filterRemoved, dialog };
}
