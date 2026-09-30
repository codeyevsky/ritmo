import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatDurationLong, manifestToJson } from '@ritmo/core';
import type {
  Artwork,
  GithubPublishResult,
  Pack,
  PackItem,
  PackPublishRequest,
  Track,
  Uri,
} from '@ritmo/core';

import {
  Artwork as ArtworkImage,
  Badge,
  Button,
  EmptyState,
  EntityHero,
  ErrorBanner,
  IconButton,
  Input,
  Modal,
  Spinner,
  TrackRow,
} from '../components';
import type { MenuItemSpec } from '../components';
import type { IconComponent } from '../icons';
import { useAsync, useGithub, useQueue, useToast, useTranslation } from '../hooks';
import { usePacks } from '../hooks/usePacks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';
import {
  ExternalLink,
  Folder,
  GripVertical,
  IconCopy,
  IconPackage,
  IconTrash,
  Refresh,
  Storefront,
} from '../icons';
import { decodeEntityUri } from '../routes';
import { useAddToPackItems } from '../shell/AddToPackMenu';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';
import { EntityHeroSkeleton, TrackListSkeleton } from './AlbumView';

/** Matches the queue row height the drag maths depends on. */
const ROW_HEIGHT = 44;

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function artworkKey(artwork: Artwork | undefined): string {
  return artwork?.sources[0]?.url ?? '';
}

function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The largest cover that is a file on this machine — what publishing copies. */
function localCover(artwork: Artwork | undefined): string | undefined {
  const sources = artwork?.sources ?? [];
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const url = sources[i]?.url;
    if (url !== undefined && url.length > 0 && !isRemote(url)) return url;
  }
  return undefined;
}

/** The largest cover that is already a web URL — what publishing links to. */
function remoteCover(artwork: Artwork | undefined): string | undefined {
  const sources = artwork?.sources ?? [];
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const url = sources[i]?.url;
    if (url !== undefined && isRemote(url)) return url;
  }
  return undefined;
}

/** The publish toast hands over a path and a URL shape, so it outlasts a
 *  plain confirmation without turning into something that has to be dismissed. */
const PUBLISHED_TOAST_MS = 6000;

/** `https://<host>/<folder>/index.json` — the shape the publisher shares. */
function shareShape(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter((part) => part.length > 0);
  const folder = parts[parts.length - 1] ?? 'packs';
  return `https://<host>/${folder}/index.json`;
}

// ── item list ───────────────────────────────────────────────────────────────

interface PackItemListProps {
  items: PackItem[];
  currentUri?: Uri;
  playing: boolean;
  likedUris: Set<Uri>;
  offlineUris: Set<Uri>;
  onMove: (from: number, to: number) => void;
  onPlay: (position: number) => void;
  onToggleLike: (track: Track) => void;
  onRemove: (position: number) => void;
  onReresolve: () => void;
  menuItemsFor: (item: PackItem) => MenuItemSpec[];
  dragLabel: string;
  unavailableLabel: string;
  reresolveLabel: string;
  removeLabel: string;
}

/**
 * Pointer-event reorder over the *entries*, resolved or not — an unavailable
 * track still holds its place in the pack, so it has to be draggable like any
 * other row. Same mechanism as `PlaylistView`: no dnd library, no HTML5
 * drag-and-drop.
 */
function PackItemList({
  items,
  currentUri,
  playing,
  likedUris,
  offlineUris,
  onMove,
  onPlay,
  onToggleLike,
  onRemove,
  onReresolve,
  menuItemsFor,
  dragLabel,
  unavailableLabel,
  reresolveLabel,
  removeLabel,
}: PackItemListProps): ReactElement {
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number } | null>(null);

  const begin = useCallback(
    (index: number, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      dragRef.current = { from: index, to: index };
      setDrag({ from: index, to: index, dy: 0 });

      const onMoveEvent = (e: PointerEvent) => {
        const dy = e.clientY - startY;
        const to = Math.min(items.length - 1, Math.max(0, index + Math.round(dy / ROW_HEIGHT)));
        dragRef.current = { from: index, to };
        setDrag({ from: index, to, dy });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMoveEvent);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        const finished = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (finished && finished.to !== finished.from) onMove(finished.from, finished.to);
      };
      window.addEventListener('pointermove', onMoveEvent);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [items.length, onMove],
  );

  return (
    <div className="relative" role="list">
      {drag !== null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent"
          style={{ transform: `translateY(${drag.to * ROW_HEIGHT}px)` }}
        />
      ) : null}
      {items.map((item, index) => {
        const isDragging = drag?.from === index;
        const handleProps = {
          'aria-label': dragLabel,
          tabIndex: 0,
          onPointerDown: (e: ReactPointerEvent<HTMLElement>) => begin(index, e),
          onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            if (e.key === 'ArrowUp' && index > 0) {
              e.preventDefault();
              onMove(index, index - 1);
            } else if (e.key === 'ArrowDown' && index < items.length - 1) {
              e.preventDefault();
              onMove(index, index + 1);
            }
          },
        };
        const track = item.track;
        return (
          <div
            key={`${item.position}-${track?.uri ?? item.entry.title}`}
            role="listitem"
            className={isDragging ? 'relative z-20 opacity-90 ring-1 ring-accent' : 'relative'}
            style={{
              height: `${ROW_HEIGHT}px`,
              transform: isDragging && drag ? `translateY(${drag.dy}px)` : undefined,
            }}
          >
            {track !== undefined ? (
              <TrackRow
                track={track}
                variant="queue"
                active={currentUri === track.uri}
                playing={playing && currentUri === track.uri}
                liked={likedUris.has(track.uri)}
                offline={offlineUris.has(track.uri)}
                onPlay={() => onPlay(item.position)}
                onToggleLike={() => onToggleLike(track)}
                menuItems={menuItemsFor(item)}
                dragHandleProps={handleProps}
              />
            ) : (
              <UnavailableRow
                item={item}
                handleProps={handleProps}
                label={unavailableLabel}
                reresolveLabel={reresolveLabel}
                removeLabel={removeLabel}
                onReresolve={onReresolve}
                onRemove={() => onRemove(item.position)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface UnavailableRowProps {
  item: PackItem;
  handleProps: React.HTMLAttributes<HTMLElement>;
  label: string;
  reresolveLabel: string;
  removeLabel: string;
  onReresolve: () => void;
  onRemove: () => void;
}

/**
 * An entry nothing resolves. Greyed and struck through rather than hidden,
 * because the pack still carries it — the note says why, and the row offers
 * the two things that can be done about it.
 */
function UnavailableRow({
  item,
  handleProps,
  label,
  reresolveLabel,
  removeLabel,
  onReresolve,
  onRemove,
}: UnavailableRowProps): ReactElement {
  return (
    <div className="flex h-full min-w-0 items-center gap-2 rounded-sm px-2 text-text-faint">
      <span
        role="presentation"
        {...handleProps}
        className="flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
      <span className="tile flex h-8 w-8 shrink-0 items-center justify-center rounded-sm">
        <IconPackage className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="min-w-0 truncate text-sm line-through decoration-line">
          {item.entry.title}
        </span>
        <span className="min-w-0 truncate text-[11px]">{item.entry.artists.join(', ')}</span>
      </span>
      {/* Allowed to shrink and clip rather than push the row wider: the same
          note is spelled out in full in the banner above the list. */}
      <Badge tone="warn" className="min-w-0 shrink overflow-hidden">
        <span className="min-w-0 truncate">{label}</span>
      </Badge>
      <span className="flex shrink-0 items-center gap-1">
        <IconButton icon={Refresh} label={reresolveLabel} size="sm" onClick={onReresolve} />
        <IconButton icon={IconTrash} label={removeLabel} size="sm" onClick={onRemove} />
      </span>
    </div>
  );
}

// ── edit modal ──────────────────────────────────────────────────────────────

interface EditModalProps {
  open: boolean;
  pack: Pack;
  tracks: Track[];
  onClose: () => void;
  onSave: (next: {
    name: string;
    description: string;
    author: string;
    artwork: Artwork | undefined;
  }) => Promise<void>;
}

function EditModal({ open, pack, tracks, onClose, onSave }: EditModalProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(pack.name);
  const [description, setDescription] = useState(pack.description ?? '');
  const [author, setAuthor] = useState(pack.author ?? '');
  const [artwork, setArtwork] = useState<Artwork | undefined>(pack.artwork);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    if (!open) return;
    setName(pack.name);
    setDescription(pack.description ?? '');
    setAuthor(pack.author ?? '');
    setArtwork(pack.artwork);
    setError(undefined);
  }, [open, pack]);

  const choices = useMemo(() => {
    const seen = new Map<string, Artwork>();
    for (const track of tracks) {
      const candidate = track.artwork;
      if (!candidate) continue;
      const key = artworkKey(candidate);
      if (key !== '' && !seen.has(key)) seen.set(key, candidate);
      if (seen.size >= 12) break;
    }
    return [...seen.entries()];
  }, [tracks]);

  const save = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setBusy(true);
    setError(undefined);
    void onSave({ name: trimmed, description: description.trim(), author: author.trim(), artwork })
      .then(onClose)
      .catch((e: unknown) => setError(e))
      .finally(() => setBusy(false));
  }, [name, description, author, artwork, onSave, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('pack.editTitle')}
      size="md"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={name.trim() === ''}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-dim">{t('pack.name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-dim">{t('pack.description')}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="selectable w-full resize-none rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-dim">{t('pack.author')}</span>
          <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </label>

        {choices.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-dim">{t('pack.artwork')}</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setArtwork(undefined)}
                aria-pressed={artwork === undefined}
                className={
                  artwork === undefined
                    ? 'flex h-16 w-16 items-center justify-center rounded-md bg-surface-3 text-[11px] text-text ring-2 ring-accent'
                    : 'flex h-16 w-16 items-center justify-center rounded-md bg-surface-3 text-[11px] text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                }
              >
                {t('common.none')}
              </button>
              {choices.map(([key, candidate]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setArtwork(candidate)}
                  aria-pressed={artworkKey(artwork) === key}
                  aria-label={t('pack.artwork')}
                  className={
                    artworkKey(artwork) === key
                      ? 'rounded-md ring-2 ring-accent'
                      : 'rounded-md ring-1 ring-line hover:ring-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                  }
                >
                  <ArtworkImage artwork={candidate} size={64} rounded="md" />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {error !== undefined ? (
          <ErrorBanner
            title={t('errors.saveFailed')}
            body={errorBody(error)}
            onDismiss={() => setError(undefined)}
          />
        ) : null}
      </div>
    </Modal>
  );
}

// ── publish dialog ──────────────────────────────────────────────────────────

interface PublishChoiceProps {
  icon: IconComponent;
  title: string;
  body: string;
  disabled: boolean;
  busy?: boolean;
  busyLabel?: string;
  onSelect: () => void;
}

function PublishChoice({
  icon: Icon,
  title,
  body,
  disabled,
  busy = false,
  busyLabel,
  onSelect,
}: PublishChoiceProps): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-start gap-3 rounded-md border border-line bg-surface-2/60 px-4 py-3 text-left hover:border-text-faint hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-surface-2/60"
    >
      <span className="tile mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm">
        {busy ? <Spinner className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-text">{title}</span>
        <span className="text-xs leading-5 text-text-dim">
          {busy && busyLabel !== undefined ? busyLabel : body}
        </span>
      </span>
    </button>
  );
}

interface PublishModalProps {
  open: boolean;
  pack: Pack;
  onClose: () => void;
}

type PublishStage = 'choose' | 'working' | 'done';

/**
 * Two destinations, one document. The folder is what serves any static host and
 * stays the general answer; GitHub Pages is the same tree uploaded for the user
 * — Ritmo stages it in its own cache, pushes it in one commit and reports the
 * address, so publishing never sends anyone to a terminal.
 */
function PublishModal({ open, pack, onClose }: PublishModalProps): ReactElement {
  const { t } = useTranslation();
  const { packs: service, host } = useServices();
  const toast = useToast();
  const github = useGithub();

  const [stage, setStage] = useState<PublishStage>('choose');
  const [result, setResult] = useState<GithubPublishResult | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  const reloadAccount = github.reload;
  useEffect(() => {
    if (!open) return;
    setStage('choose');
    setResult(undefined);
    setError(undefined);
    // A token pasted in Settings since this view mounted has to count.
    reloadAccount();
  }, [open, reloadAccount]);

  const request = useCallback(async (): Promise<PackPublishRequest> => {
    const manifest = await service.toManifest(pack.uri);
    return {
      name: pack.name,
      description: pack.description,
      packs: [
        {
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          author: manifest.author,
          trackCount: manifest.tracks.length,
          updatedAt: manifest.updatedAt,
          json: manifestToJson(manifest),
          coverPath: localCover(pack.artwork),
          artworkUrl: remoteCover(pack.artwork),
        },
      ],
    };
  }, [service, pack]);

  const toFolder = useCallback(() => {
    const files = host.packFiles;
    if (files === undefined) {
      toast.toast({ title: t('pack.desktopOnly'), tone: 'warn' });
      return;
    }
    void (async () => {
      try {
        const dir = await files.pickPublishDir();
        if (dir === undefined) return;
        const written = await files.publish(dir, await request());
        onClose();
        toast.toast({
          title: t('pack.published'),
          body: `${written.dir} · ${t('pack.publishHint', { url: shareShape(written.dir) })}`,
          tone: 'success',
          durationMs: PUBLISHED_TOAST_MS,
        });
      } catch (e: unknown) {
        setError(e);
      }
    })();
  }, [host, request, onClose, toast, t]);

  const toGithub = useCallback(() => {
    const files = host.packFiles;
    const upload = host.publishToGithub;
    if (files === undefined || upload === undefined) {
      toast.toast({ title: t('pack.desktopOnly'), tone: 'warn' });
      return;
    }
    setStage('working');
    setError(undefined);
    void (async () => {
      try {
        // The tree is written to disk first and only then uploaded: the Rust
        // command reads a folder, it does not serialise packs itself.
        const dir = await files.stagingDir();
        await files.publish(dir, await request());
        setResult(await upload.call(host, { token: github.token, repo: github.repo, dir }));
        setStage('done');
      } catch (e: unknown) {
        setError(e);
        setStage('choose');
      }
    })();
  }, [host, request, github.token, github.repo, toast, t]);

  const copy = useCallback(() => {
    if (result === undefined) return;
    void navigator.clipboard
      .writeText(result.indexUrl)
      .then(() => toast.toast({ title: t('common.copied'), tone: 'success' }))
      .catch(() => toast.toast({ title: t('errors.copyFailed'), tone: 'danger' }));
  }, [result, toast, t]);

  const working = stage === 'working';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('pack.publish')}
      description={stage === 'done' ? undefined : t('pack.publishChoose')}
      size="md"
      dismissible={!working}
      actions={
        <Button variant="ghost" onClick={onClose} disabled={working}>
          {stage === 'done' ? t('common.close') : t('common.cancel')}
        </Button>
      }
    >
      {stage === 'done' && result !== undefined ? (
        <div className="flex min-w-0 flex-col gap-3">
          <span className="text-xs font-medium text-text-dim">{t('pack.publishAddress')}</span>
          <code className="selectable mono block break-all rounded-sm border border-line bg-surface-2 px-3 py-2 text-[13px] text-text">
            {result.indexUrl}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" leading={IconCopy} onClick={copy}>
              {t('common.copy')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              trailing={ExternalLink}
              onClick={() => void host.openExternal(result.indexUrl)}
            >
              {t('pack.publishOpen')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              trailing={ExternalLink}
              onClick={() => void host.openExternal(result.repoUrl)}
            >
              {t('pack.publishOpenRepo')}
            </Button>
          </div>
          {result.pagesPending ? (
            <p className="text-xs leading-5 text-text-dim">{t('pack.publishPending')}</p>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <PublishChoice
            icon={Folder}
            title={t('pack.publishFolder')}
            body={t('pack.publishFolderDesc')}
            disabled={working}
            onSelect={toFolder}
          />
          <PublishChoice
            icon={Storefront}
            title={t('pack.publishGithub')}
            body={github.canPublish ? t('pack.publishGithubDesc') : t('pack.publishGithubNoToken')}
            disabled={!github.canPublish || working}
            busy={working}
            busyLabel={t('pack.publishGithubBusy')}
            onSelect={toGithub}
          />
          {error !== undefined ? (
            <ErrorBanner
              title={t('pack.publishFailed')}
              body={errorBody(error)}
              onDismiss={() => setError(undefined)}
            />
          ) : null}
        </div>
      )}
    </Modal>
  );
}

// ── view ────────────────────────────────────────────────────────────────────

export function PackView(): ReactElement {
  const params = useParams<{ uri: string }>();
  const uri = decodeEntityUri(params.uri) ?? '';
  const { packs: service, host, controller } = useServices();
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queue = useQueue();
  const { update, remove, move, removeAt, reresolve, canPublish } = usePacks();

  const likedUris = useLibraryStore((s) => s.likedUris);
  const offlineUris = useLibraryStore((s) => s.offlineUris);
  const currentUri = usePlayerStore((s) => s.current?.uri);
  const isPlaying = usePlayerStore((s) => s.status === 'playing');
  const contextUri = usePlayerStore((s) => s.queue.contextUri);

  const [editing, setEditing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<PackItem[] | undefined>(undefined);

  const fetchPack = useCallback(async (): Promise<Pack | undefined> => {
    if (uri === '') return undefined;
    return service.get(uri, true);
  }, [service, uri]);

  const pack = useAsync(fetchPack, [fetchPack], { keepPrevious: true });
  const data = pack.data;
  const fetched = useMemo(() => data?.items ?? [], [data]);
  const items = order ?? fetched;

  // A refetch is the source of truth again; drop the optimistic order.
  useEffect(() => {
    setOrder(undefined);
  }, [fetched]);

  useEffect(() => {
    if (data) document.title = `${data.name} · Ritmo`;
  }, [data]);

  const tracks = useMemo(
    () => items.map((item) => item.track).filter((track): track is Track => track !== undefined),
    [items],
  );
  const unavailable = items.length - tracks.length;
  const totalMs = useMemo(() => tracks.reduce((sum, track) => sum + track.durationMs, 0), [tracks]);
  const addToPlaylist = useAddToPlaylistItems(tracks);
  const addToPack = useAddToPackItems(tracks);

  const play = useCallback(
    (position: number) => {
      if (!data || tracks.length === 0) return;
      const wanted = items.find((item) => item.position === position)?.track?.uri;
      const index = Math.max(0, tracks.findIndex((track) => track.uri === wanted));
      void controller.playContext(tracks, index, { uri: data.uri, name: data.name });
    },
    [controller, data, items, tracks],
  );

  const shuffle = useCallback(() => {
    if (!data || tracks.length === 0) return;
    void (async () => {
      await controller.setShuffle(true);
      await controller.playContext(tracks, Math.floor(Math.random() * tracks.length), {
        uri: data.uri,
        name: data.name,
      });
    })();
  }, [controller, data, tracks]);

  const onMove = useCallback(
    (from: number, to: number) => {
      if (!data) return;
      setOrder((prev) => {
        const base = prev ?? fetched;
        const next = [...base];
        const [moved] = next.splice(from, 1);
        if (!moved) return prev;
        next.splice(to, 0, moved);
        return next;
      });
      void move(data.uri, from, to).catch((e: unknown) => {
        setOrder(undefined);
        toast.toast({ title: t('errors.saveFailed'), body: errorBody(e), tone: 'danger' });
      });
    },
    [data, fetched, move, toast, t],
  );

  const onRemove = useCallback(
    (position: number) => {
      if (!data) return;
      void removeAt(data.uri, [position])
        .then(() => pack.reload())
        .catch((e: unknown) =>
          toast.toast({ title: t('errors.saveFailed'), body: errorBody(e), tone: 'danger' }),
        );
    },
    [data, removeAt, pack, toast, t],
  );

  const onReresolve = useCallback(() => {
    if (!data) return;
    const id = `reresolve:${data.uri}`;
    setBusy(true);
    toast.toast({ id, title: t('pack.reresolving'), durationMs: 0, progress: 0 });
    void reresolve(data.uri)
      .then((report) => {
        const found = unavailable - report.unavailable;
        toast.toast({
          id,
          title: found > 0 ? t('pack.reresolved', { count: found }) : t('pack.reresolvedNone'),
          tone: found > 0 ? 'success' : 'neutral',
          progress: 1,
        });
        pack.reload();
      })
      .catch((e: unknown) =>
        toast.toast({ id, title: t('errors.generic'), body: errorBody(e), tone: 'danger' }),
      )
      .finally(() => setBusy(false));
  }, [data, reresolve, unavailable, pack, toast, t]);

  const onExport = useCallback(() => {
    const files = host.packFiles;
    if (!data) return;
    if (files === undefined) {
      toast.toast({ title: t('pack.desktopOnly'), tone: 'warn' });
      return;
    }
    void (async () => {
      try {
        const manifest = await service.toManifest(data.uri);
        const path = await files.pickExportPath(manifest.name);
        if (path === undefined) return;
        await files.writePack(path, manifestToJson(manifest));
        toast.toast({ title: t('pack.exported'), body: path, tone: 'success', durationMs: 6000 });
      } catch (e: unknown) {
        toast.toast({ title: t('errors.exportFailed'), body: errorBody(e), tone: 'danger' });
      }
    })();
  }, [data, host, service, toast, t]);

  const onDelete = useCallback(() => {
    if (!data) return;
    void remove(data.uri)
      .then(() => {
        setConfirmDelete(false);
        navigate('/library/playlists');
      })
      .catch((e: unknown) =>
        toast.toast({ title: t('errors.generic'), body: errorBody(e), tone: 'danger' }),
      );
  }, [data, remove, navigate, toast, t]);

  const saveEdits = useCallback(
    async (next: {
      name: string;
      description: string;
      author: string;
      artwork: Artwork | undefined;
    }) => {
      if (!data) return;
      await update(data.uri, {
        name: next.name,
        description: next.description,
        author: next.author,
        artwork: next.artwork,
      });
      pack.reload();
    },
    [data, update, pack],
  );

  const menuItems = useMemo<MenuItemSpec[]>(() => {
    if (!data) return [];
    const out: MenuItemSpec[] = [
      { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue(tracks) },
      { id: 'add', label: t('playlist.addTo'), items: addToPlaylist },
      { id: 'edit', label: t('pack.edit'), separatorBefore: true, onSelect: () => setEditing(true) },
    ];
    if (unavailable > 0) {
      out.push({
        id: 'reresolve',
        label: t('pack.reresolve'),
        icon: Refresh,
        disabled: busy,
        onSelect: onReresolve,
      });
    }
    out.push(
      {
        id: 'export',
        label: t('pack.export'),
        separatorBefore: true,
        disabled: !canPublish,
        onSelect: onExport,
      },
      {
        id: 'publish',
        label: t('pack.publish'),
        disabled: !canPublish,
        onSelect: () => setPublishing(true),
      },
      {
        id: 'delete',
        label: t('pack.delete'),
        danger: true,
        separatorBefore: true,
        onSelect: () => setConfirmDelete(true),
      },
    );
    return out;
  }, [
    data,
    t,
    queue,
    tracks,
    addToPlaylist,
    unavailable,
    busy,
    onReresolve,
    canPublish,
    onExport,
  ]);

  const rowMenuItems = useCallback(
    (item: PackItem): MenuItemSpec[] => {
      const out: MenuItemSpec[] = [];
      const track = item.track;
      if (track !== undefined) {
        out.push(
          { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue([track]) },
          { id: 'next', label: t('queue.playNext'), onSelect: () => queue.addNext([track]) },
          { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, separatorBefore: true },
          { id: 'add-pack', label: t('pack.addTo'), items: addToPack },
        );
      } else {
        out.push({
          id: 'reresolve',
          label: t('pack.reresolve'),
          icon: Refresh,
          disabled: busy,
          onSelect: onReresolve,
        });
      }
      out.push({
        id: 'remove',
        label: t('pack.removeFromPack'),
        danger: true,
        separatorBefore: true,
        onSelect: () => onRemove(item.position),
      });
      return out;
    },
    [t, queue, addToPlaylist, addToPack, busy, onReresolve, onRemove],
  );

  const toggleLike = useCallback((track: Track) => {
    void useLibraryStore.getState().toggleLike(track);
  }, []);

  if (pack.loading && data === undefined) {
    return (
      <div className="flex flex-col gap-6 pb-12">
        <EntityHeroSkeleton />
        <TrackListSkeleton />
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="p-6">
        <ErrorBanner
          title={t('errors.notFound')}
          body={errorBody(pack.error)}
          onRetry={pack.reload}
        />
      </div>
    );
  }

  const playingThis = isPlaying && contextUri === data.uri;
  const meta = [
    data.author !== undefined && data.author !== '' ? data.author : undefined,
    t('pack.trackCount', { count: items.length }),
    unavailable > 0 ? t('pack.unavailableCount', { count: unavailable }) : undefined,
    totalMs > 0 ? formatDurationLong(totalMs, lang) : undefined,
    data.source === 'remote' && data.sourceUrl !== undefined
      ? t('pack.installedFrom', { name: data.sourceUrl })
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  return (
    <div className="flex flex-col gap-6 pb-12">
      <EntityHero
        kind="playlist"
        eyebrow={t('pack.pack')}
        title={data.name}
        subtitle={
          data.description !== undefined && data.description !== '' ? (
            <span className="selectable">{data.description}</span>
          ) : undefined
        }
        meta={meta}
        artwork={data.artwork}
        playing={playingThis}
        onPlay={() => (playingThis ? void controller.toggle() : play(items[0]?.position ?? 0))}
        onShuffle={shuffle}
        menuItems={menuItems}
        editable
        onEdit={() => setEditing(true)}
      />

      <div className="flex min-w-0 flex-col gap-3 px-6">
        {unavailable > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-line bg-surface-2/60 px-4 py-3">
            <span className="min-w-0 flex-1 text-sm text-text-dim">
              <span className="font-medium text-text">
                {t('pack.unavailableCount', { count: unavailable })}
              </span>{' '}
              {t('pack.unavailableBody')}
            </span>
            <Button
              variant="outline"
              size="sm"
              leading={Refresh}
              loading={busy}
              onClick={onReresolve}
              className="shrink-0"
            >
              {t('pack.reresolve')}
            </Button>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rule-label min-w-0 flex-1">{t('pack.reorder')}</span>
          <span className="mono flex min-w-0 items-center gap-1 text-[10px] text-text-faint">
            <GripVertical className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{t('pack.reorderHint')}</span>
          </span>
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon={IconPackage}
            title={t('pack.empty')}
            body={t('pack.emptyBody')}
            action={{ label: t('nav.search'), onClick: () => navigate('/search') }}
          />
        ) : (
          <PackItemList
            items={items}
            currentUri={currentUri}
            playing={isPlaying}
            likedUris={likedUris}
            offlineUris={offlineUris}
            onMove={onMove}
            onPlay={play}
            onToggleLike={toggleLike}
            onRemove={onRemove}
            onReresolve={onReresolve}
            menuItemsFor={rowMenuItems}
            dragLabel={t('pack.dragHandle')}
            unavailableLabel={t('pack.unavailable')}
            reresolveLabel={t('pack.reresolve')}
            removeLabel={t('pack.removeFromPack')}
          />
        )}
      </div>

      <PublishModal open={publishing} pack={data} onClose={() => setPublishing(false)} />

      <EditModal
        open={editing}
        pack={data}
        tracks={tracks}
        onClose={() => setEditing(false)}
        onSave={saveEdits}
      />

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('pack.delete')}
        description={t('pack.deleteConfirmBody', { name: data.name })}
        size="sm"
        dismissible={false}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={onDelete}>
              {t('common.delete')}
            </Button>
          </>
        }
      />
    </div>
  );
}

export default PackView;
