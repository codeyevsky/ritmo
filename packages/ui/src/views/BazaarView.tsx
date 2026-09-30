import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { MAX_TRACKS_PER_PACK, formatDuration, parseManifest } from '@ritmo/core';
import type { BazaarEntry, BazaarSource, Pack, PackManifest } from '@ritmo/core';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  IconButton,
  Input,
  Modal,
  Spinner,
} from '../components';
import { useAsync, useToast, useTranslation } from '../hooks';
import { usePacks } from '../hooks/usePacks';
import { useServices } from '../services';
import { Download, IconBazaar, IconPackage, IconPlus, IconTrash, Refresh } from '../icons';
import { packPath } from '../routes';

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/** A card subtitle: author and track count, never the raw url. */
function subtitleFor(entry: BazaarEntry, tracksLabel: string): string {
  const author = entry.author !== undefined && entry.author !== '' ? entry.author : undefined;
  return [author, tracksLabel].filter((part): part is string => part !== undefined).join(' · ');
}

// ── sources ─────────────────────────────────────────────────────────────────

interface SourceRowProps {
  source: BazaarSource;
  busy: boolean;
  onRefresh: () => void;
  onRemove: () => void;
}

function SourceRow({ source, busy, onRefresh, onRemove }: SourceRowProps): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="flex min-w-0 items-center gap-3 border-b border-line/40 px-3 py-2.5 last:border-b-0">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-text">
            {source.name !== undefined && source.name !== '' ? source.name : source.url}
          </span>
          <Badge tone={source.ok ? 'accent' : 'danger'} className="shrink-0">
            {source.ok ? t('bazaar.stateOk') : t('bazaar.stateFailed')}
          </Badge>
        </span>
        {/* The url is the identity of the source, so it is always visible —
            as text, truncated, never as a link the page follows itself. */}
        <span className="mono min-w-0 truncate text-[11px] text-text-faint">{source.url}</span>
        {source.error !== undefined ? (
          <span className="min-w-0 break-words text-[11px] text-danger">{source.error}</span>
        ) : null}
        {source.lastFetchAt === undefined ? (
          <span className="text-[11px] text-text-faint">{t('bazaar.notCheckedYet')}</span>
        ) : null}
      </span>
      <span className="mono shrink-0 text-[11px] text-text-faint">
        {source.packCount === undefined
          ? null
          : t('bazaar.packCount', { count: source.packCount })}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <IconButton
          icon={Refresh}
          label={t('bazaar.refresh')}
          size="sm"
          disabled={busy}
          onClick={onRefresh}
        />
        <IconButton icon={IconTrash} label={t('bazaar.removeSource')} size="sm" onClick={onRemove} />
      </span>
    </li>
  );
}

// ── preview ─────────────────────────────────────────────────────────────────

interface PreviewModalProps {
  entry: BazaarEntry | null;
  onClose: () => void;
  onInstalled: (pack: Pack) => void;
}

/**
 * What a card opens: the pack's own track list, fetched on demand, plus the
 * Install action. Every string in here is rendered as text — an index is a
 * stranger's document, so nothing it carries is ever interpreted as markup.
 */
function PreviewModal({ entry, onClose, onInstalled }: PreviewModalProps): ReactElement {
  const { t } = useTranslation();
  const { bazaar } = useServices();
  const { refresh } = usePacks();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const load = useCallback(async (): Promise<PackManifest | undefined> => {
    if (entry === null) return undefined;
    return bazaar.preview(entry);
  }, [bazaar, entry]);

  const manifest = useAsync(load, [load], { enabled: entry !== null });

  const install = useCallback(() => {
    if (entry === null) return;
    setInstalling(true);
    setError(undefined);
    void bazaar
      .installFromBazaar(entry)
      .then(async (pack) => {
        await refresh();
        onInstalled(pack);
        onClose();
      })
      .catch((e: unknown) => setError(e))
      .finally(() => setInstalling(false));
  }, [bazaar, entry, refresh, onInstalled, onClose]);

  const tracks = manifest.data?.tracks ?? [];

  return (
    <Modal
      open={entry !== null}
      onClose={onClose}
      title={entry?.name ?? ''}
      description={entry?.description}
      size="lg"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={installing}
            disabled={manifest.data === undefined}
            onClick={install}
          >
            {installing ? t('bazaar.installing') : t('bazaar.install')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-text-dim">
          {entry?.author !== undefined && entry.author !== '' ? (
            <span className="min-w-0 truncate">{t('common.by', { name: entry.author })}</span>
          ) : null}
          <span className="mono shrink-0">
            {t('pack.trackCount', { count: entry?.trackCount ?? 0 })}
          </span>
          {entry?.sourceName !== undefined ? (
            <span className="min-w-0 truncate">
              {t('pack.installedFrom', { name: entry.sourceName })}
            </span>
          ) : null}
        </div>

        {manifest.loading ? (
          <div className="flex items-center gap-2 px-1 py-4 text-sm text-text-dim">
            <Spinner size="sm" />
            {t('common.loading')}
          </div>
        ) : null}

        {manifest.error !== undefined ? (
          <ErrorBanner
            title={t('errors.loadFailed')}
            body={errorBody(manifest.error)}
            onRetry={manifest.reload}
          />
        ) : null}

        {tracks.length > 0 ? (
          <ol className="scrollbar-thin max-h-80 min-w-0 overflow-y-auto overflow-x-hidden rounded-md border border-line">
            {tracks.map((track, index) => (
              <li
                key={`${index}-${track.title}`}
                className="flex min-w-0 items-center gap-3 border-b border-line/40 px-3 py-2 last:border-b-0"
              >
                <span className="mono w-8 shrink-0 text-right text-[11px] text-text-faint">
                  {index + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate text-sm text-text">{track.title}</span>
                  <span className="min-w-0 truncate text-[11px] text-text-dim">
                    {track.artists.join(', ')}
                  </span>
                </span>
                <span className="mono shrink-0 text-[11px] text-text-faint">
                  {track.durationMs > 0 ? formatDuration(track.durationMs) : '—'}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {error !== undefined ? (
          <ErrorBanner
            title={t('bazaar.installFailed')}
            body={errorBody(error)}
            onDismiss={() => setError(undefined)}
          />
        ) : null}

        <p className="text-[11px] leading-relaxed text-text-faint">{t('bazaar.trustNote')}</p>
      </div>
    </Modal>
  );
}

// ── view ────────────────────────────────────────────────────────────────────

export function BazaarView(): ReactElement {
  const { t } = useTranslation();
  const { bazaar, packs: service, host } = useServices();
  const { refresh: refreshPacks, canPublish } = usePacks();
  const navigate = useNavigate();
  const toast = useToast();

  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BazaarEntry | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    document.title = `${t('bazaar.title')} · Ritmo`;
  }, [t]);

  // `nonce` is the dependency that makes a refresh/add/remove re-read: the
  // Bazaar has no change events, so the view owns when to look again.
  const loadSources = useCallback(() => bazaar.sources(), [bazaar, nonce]);
  const loadCatalogue = useCallback(() => bazaar.catalogue(), [bazaar, nonce]);

  const sources = useAsync(loadSources, [loadSources], { keepPrevious: true });
  const catalogue = useAsync(loadCatalogue, [loadCatalogue], { keepPrevious: true });

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const onAdd = useCallback(() => {
    const candidate = url.trim();
    if (candidate === '') return;
    setAdding(true);
    setAddError(undefined);
    void bazaar
      .addSource(candidate)
      .then((source) => {
        setUrl('');
        reload();
        if (!source.ok) {
          toast.toast({ title: t('bazaar.stateFailed'), body: source.error, tone: 'warn' });
        }
      })
      .catch((e: unknown) => setAddError(e))
      .finally(() => setAdding(false));
  }, [bazaar, url, reload, toast, t]);

  const onRefreshAll = useCallback(() => {
    setBusy(true);
    void bazaar
      .refresh()
      .then(reload)
      .catch((e: unknown) =>
        toast.toast({ title: t('errors.loadFailed'), body: errorBody(e), tone: 'danger' }),
      )
      .finally(() => setBusy(false));
  }, [bazaar, reload, toast, t]);

  const onRefreshOne = useCallback(
    (source: BazaarSource) => {
      setBusy(true);
      void bazaar
        .refresh(source.url)
        .then(reload)
        .catch(() => undefined)
        .finally(() => setBusy(false));
    },
    [bazaar, reload],
  );

  const onRemoveOne = useCallback(
    (source: BazaarSource) => {
      void bazaar
        .removeSource(source.url)
        .then(reload)
        .catch((e: unknown) =>
          toast.toast({ title: t('errors.generic'), body: errorBody(e), tone: 'danger' }),
        );
    },
    [bazaar, reload, toast, t],
  );

  const onInstalled = useCallback(
    (pack: Pack) => {
      const resolved = pack.trackCount - pack.unavailableCount;
      toast.toast({
        title: t('bazaar.installed', { name: pack.name }),
        body: t('pack.resolvedCount', { resolved, total: pack.trackCount }),
        tone: resolved === pack.trackCount ? 'success' : 'warn',
        durationMs: 8000,
      });
      navigate(packPath(pack.uri));
    },
    [navigate, toast, t],
  );

  /**
   * A pack file someone sent directly, rather than through a source. It goes
   * through the same `parseManifest` the Bazaar uses, with the same track cap:
   * a file off a stranger's USB stick is no more trustworthy than an index.
   */
  const onImport = useCallback(() => {
    const files = host.packFiles;
    if (files === undefined) {
      toast.toast({ title: t('pack.desktopOnly'), tone: 'warn' });
      return;
    }
    void (async () => {
      try {
        const path = await files.pickImport();
        if (path === undefined) return;
        const document = await files.readPack(path);
        const manifest = parseManifest(document, { maxTracks: MAX_TRACKS_PER_PACK });
        const installed = await service.install(manifest);
        await refreshPacks();
        toast.toast({
          title: t('pack.imported', { name: installed.name }),
          body: t('pack.resolvedCount', {
            resolved: installed.trackCount - installed.unavailableCount,
            total: installed.trackCount,
          }),
          tone: 'success',
          durationMs: 8000,
        });
        navigate(packPath(installed.uri));
      } catch (e: unknown) {
        toast.toast({ title: t('errors.loadFailed'), body: errorBody(e), tone: 'danger' });
      }
    })();
  }, [host, service, refreshPacks, navigate, toast, t]);

  const entries = useMemo(() => catalogue.data ?? [], [catalogue.data]);
  const sourceList = sources.data ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-6 pb-12">
      <header className="flex min-w-0 flex-col gap-2 border-b border-line px-6 pb-5 pt-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className="tile flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
            <IconBazaar className="h-5 w-5 text-accent" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-text">
              {t('bazaar.title')}
            </h1>
            <p className="min-w-0 truncate text-sm text-text-dim">{t('bazaar.tagline')}</p>
          </div>
          <span className="min-w-0 flex-1" />
          <Button
            variant="ghost"
            size="sm"
            leading={Download}
            onClick={onImport}
            disabled={!canPublish}
            className="shrink-0"
          >
            {t('pack.import')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leading={Refresh}
            loading={busy}
            onClick={onRefreshAll}
            className="shrink-0"
            disabled={sourceList.length === 0}
          >
            {t('bazaar.refreshAll')}
          </Button>
        </div>
      </header>

      <section className="flex min-w-0 flex-col gap-3 px-6">
        <p className="rule-label">{t('bazaar.sources')}</p>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-[12rem] flex-1">
              <Input
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onAdd();
                }}
                placeholder="https://example.org/packs/index.json"
                aria-label={t('bazaar.sourceUrl')}
              />
            </span>
            <Button
              variant="primary"
              leading={IconPlus}
              loading={adding}
              disabled={url.trim() === ''}
              onClick={onAdd}
              className="shrink-0"
            >
              {t('bazaar.add')}
            </Button>
          </div>
          <p className="text-[11px] text-text-faint">{t('bazaar.sourceUrlHint')}</p>
          {addError !== undefined ? (
            <ErrorBanner
              title={t('bazaar.addFailed')}
              body={errorBody(addError)}
              onDismiss={() => setAddError(undefined)}
            />
          ) : null}
        </div>

        {sourceList.length > 0 ? (
          <ul className="min-w-0 rounded-md border border-line" aria-label={t('bazaar.sources')}>
            {sourceList.map((source) => (
              <SourceRow
                key={source.url}
                source={source}
                busy={busy}
                onRefresh={() => onRefreshOne(source)}
                onRemove={() => onRemoveOne(source)}
              />
            ))}
          </ul>
        ) : (
          <EmptyState icon={IconBazaar} title={t('bazaar.empty')} body={t('bazaar.emptyBody')} />
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-3 px-6">
        <p className="rule-label">{t('bazaar.catalogue')}</p>

        {catalogue.loading && entries.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-text-dim">
            <Spinner size="sm" />
            {t('common.loading')}
          </div>
        ) : null}

        {entries.length === 0 && !catalogue.loading && sourceList.length > 0 ? (
          <EmptyState
            icon={IconPackage}
            title={t('bazaar.catalogueEmpty')}
            body={t('bazaar.catalogueEmptyBody')}
            action={{ label: t('bazaar.refreshAll'), onClick: onRefreshAll }}
          />
        ) : null}

        {entries.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-3">
            {entries.map((entry) => (
              <Card
                key={`${entry.sourceUrl}|${entry.id}`}
                kind="playlist"
                uri={entry.url}
                title={entry.name}
                subtitle={subtitleFor(entry, t('pack.trackCount', { count: entry.trackCount }))}
                artwork={entry.artwork === undefined ? undefined : { sources: [{ url: entry.artwork, size: 0 }] }}
                onOpen={() => setPreview(entry)}
              />
            ))}
          </div>
        ) : null}
      </section>

      <PreviewModal entry={preview} onClose={() => setPreview(null)} onInstalled={onInstalled} />
    </div>
  );
}

export default BazaarView;
