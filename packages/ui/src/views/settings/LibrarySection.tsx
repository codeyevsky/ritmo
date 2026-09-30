import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryStats, ScanProgress, ScanResult } from '@ritmo/core';
import { formatBytes, formatDurationLong } from '@ritmo/core';

import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Modal } from '../../components/Modal';
import { Skeleton } from '../../components/Skeleton';
import { Slider } from '../../components/Slider';
import { Toggle } from '../../components/Toggle';
import { useServices } from '../../services';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { useAddMusic } from '../../shell/AddMusic';
import { SettingBlock, SettingGroup, SettingRow } from './SettingRow';

const GB = 1024 * 1024 * 1024;
const MIN_CACHE_GB = 1;
const MAX_CACHE_GB = 64;

const PHASE_KEYS = {
  walking: 'settings.scanPhaseWalking',
  reading: 'settings.scanPhaseReading',
  artwork: 'settings.scanPhaseArtwork',
  done: 'settings.scanPhaseDone',
} as const;

type Async<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T };

interface CacheUsage {
  cacheBytes: number;
  offlineBytes: number;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
      <div className="font-num text-lg tabular-nums leading-6 text-text">{value}</div>
      <div className="mt-0.5 text-xs text-text-dim">{label}</div>
    </div>
  );
}

export function LibrarySection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();
  const { host, library } = useServices();
  const lang = settings.language;
  const local = host.localLibrary;

  const [stats, setStats] = useState<Async<LibraryStats>>({ state: 'loading' });
  const [usage, setUsage] = useState<Async<CacheUsage>>({ state: 'loading' });
  const [progress, setProgress] = useState<ScanProgress | undefined>(undefined);
  const [scanResult, setScanResult] = useState<ScanResult | undefined>(undefined);
  const [scanError, setScanError] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cacheGb, setCacheGb] = useState(() =>
    Math.min(MAX_CACHE_GB, Math.max(MIN_CACHE_GB, Math.round(settings.maxCacheBytes / GB))),
  );
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadStats = useCallback(() => {
    setStats({ state: 'loading' });
    void library.repo
      .stats()
      .then((value) => {
        if (alive.current) setStats({ state: 'ready', value });
      })
      .catch(() => {
        if (alive.current) setStats({ state: 'error' });
      });
  }, [library]);

  const loadUsage = useCallback(() => {
    setUsage({ state: 'loading' });
    void (async () => {
      try {
        const offlineBytes = await library.offline.totalBytes();
        const dir = settings.cacheDir;
        const cacheBytes = dir === undefined ? 0 : await host.files.dirSize(dir);
        if (alive.current) setUsage({ state: 'ready', value: { cacheBytes, offlineBytes } });
      } catch {
        if (alive.current) setUsage({ state: 'error' });
      }
    })();
  }, [host, library, settings.cacheDir]);

  useEffect(loadStats, [loadStats]);
  useEffect(loadUsage, [loadUsage]);

  const runScan = useCallback(
    (folders: string[]) => {
      if (local === undefined || folders.length === 0) return;
      setScanning(true);
      setScanError(undefined);
      setScanResult(undefined);
      setProgress({ phase: 'walking', filesSeen: 0, filesImported: 0 });
      void local
        .scan(folders, (p) => {
          if (alive.current) setProgress(p);
        })
        .then((result) => {
          if (!alive.current) return;
          setScanResult(result);
          loadStats();
          loadUsage();
        })
        .catch((e: unknown) => {
          if (!alive.current) return;
          setScanError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!alive.current) return;
          setScanning(false);
          setProgress(undefined);
        });
    },
    [local, loadStats, loadUsage],
  );

  // Routed through this section's own `runScan` so an album folder reports into
  // the progress row above rather than scanning silently.
  const add = useAddMusic({
    onAdded: () => {
      loadStats();
      loadUsage();
    },
    scan: runScan,
  });

  const addFolder = useCallback(() => {
    void (async () => {
      try {
        const picked = await host.files.pickFolder();
        if (picked === undefined || settings.musicFolders.includes(picked)) return;
        const folders = [...settings.musicFolders, picked];
        patch({ musicFolders: folders });
        runScan(folders);
      } catch (e: unknown) {
        if (alive.current) setScanError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [host, patch, runScan, settings.musicFolders]);

  const removeFolder = (folder: string) => {
    const folders = settings.musicFolders.filter((f) => f !== folder);
    patch({ musicFolders: folders });
    if (settings.watchFolders && local !== undefined) {
      void local.setWatching(true, folders).catch(() => undefined);
    }
  };

  const setWatching = (enabled: boolean) => {
    patch({ watchFolders: enabled });
    if (local === undefined) return;
    void local.setWatching(enabled, settings.musicFolders).catch((e: unknown) => {
      if (alive.current) setScanError(e instanceof Error ? e.message : String(e));
    });
  };

  const clearCache = () => {
    setClearing(true);
    void library.offline
      .pruneTo(0)
      .then(() => {
        if (alive.current) loadUsage();
      })
      .catch(() => {
        if (alive.current) setUsage({ state: 'error' });
      })
      .finally(() => {
        if (alive.current) {
          setClearing(false);
          setConfirmClear(false);
        }
      });
  };

  const statusLine = (() => {
    if (add.busy) return t('library.importing');
    if (scanning && progress !== undefined) {
      return t('settings.scanCounts', {
        phase: t(PHASE_KEYS[progress.phase]),
        seen: progress.filesSeen,
        imported: progress.filesImported,
      });
    }
    if (scanResult !== undefined) {
      return t('settings.scanDone', {
        added: scanResult.added,
        updated: scanResult.updated,
        removed: scanResult.removed,
      });
    }
    return '';
  })();

  return (
    <div className="flex flex-col gap-4">
      {scanError !== undefined && (
        <ErrorBanner
          title={t('settings.scanFailed')}
          body={scanError}
          tone="danger"
          onRetry={() => runScan(settings.musicFolders)}
          onDismiss={() => setScanError(undefined)}
        />
      )}

      {/* Three separate actions: loose files never turn their folder into a
          scanned root, an album folder and a library root both do. */}
      {local !== undefined && (
        <SettingGroup title={t('library.addMusic')}>
          {add.canAddSingle && (
            <SettingRow
              label={t('library.addSingle')}
              description={t('library.addSingleHint')}
              control={
                <Button variant="outline" size="sm" disabled={add.busy} onClick={add.addSingle}>
                  {t('library.addSingle')}
                </Button>
              }
            />
          )}
          {add.canAddAlbum && (
            <SettingRow
              label={t('library.addAlbum')}
              description={t('library.addAlbumHint')}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={add.busy || scanning}
                  onClick={add.addAlbum}
                >
                  {t('library.addAlbum')}
                </Button>
              }
            />
          )}
          <SettingRow
            label={t('library.addFolder')}
            description={t('library.addFolderHint')}
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={add.busy || scanning}
                onClick={addFolder}
              >
                {t('library.addFolder')}
              </Button>
            }
          />
        </SettingGroup>
      )}

      {local !== undefined && (
        <SettingGroup
          title={t('settings.musicFolders')}
          description={t('settings.musicFoldersDesc')}
        >
          <SettingBlock>
            {settings.musicFolders.length === 0 ? (
              <EmptyState
                title={t('settings.noFolders')}
                body={t('settings.noFoldersBody')}
                action={{ label: t('settings.addFolder'), onClick: addFolder }}
              />
            ) : (
              <>
                <ul className="flex flex-col gap-1">
                  {settings.musicFolders.map((folder) => (
                    <li
                      key={folder}
                      className="flex min-h-11 items-center gap-3 rounded-md bg-surface-2 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-num text-xs text-text-dim">
                        {folder}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('settings.removeFolderOf', { folder })}
                        onClick={() => removeFolder(folder)}
                      >
                        {t('settings.removeFolder')}
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="mt-3">
                  <Button variant="outline" size="sm" onClick={addFolder}>
                    {t('settings.addFolder')}
                  </Button>
                </div>
              </>
            )}
          </SettingBlock>

          <SettingRow
            label={t('settings.watchFolders')}
            description={t('settings.watchFoldersDesc')}
            htmlFor="setting-watch"
            control={
              <Toggle
                id="setting-watch"
                label={t('settings.watchFolders')}
                checked={settings.watchFolders}
                disabled={settings.musicFolders.length === 0}
                onChange={setWatching}
              />
            }
          />

          <SettingBlock label={t('settings.rescan')} description={t('settings.rescanDesc')}>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                loading={scanning}
                disabled={scanning || settings.musicFolders.length === 0}
                onClick={() => runScan(settings.musicFolders)}
              >
                {t('settings.rescan')}
              </Button>
              {scanning && (
                <Button variant="ghost" size="sm" onClick={() => void local.cancelScan()}>
                  {t('settings.cancelScan')}
                </Button>
              )}
            </div>
            <p aria-live="polite" className="mt-2 min-h-5 text-xs leading-5 text-text-dim">
              {statusLine}
            </p>
            {scanning && progress?.currentPath !== undefined && (
              <p className="truncate font-num text-[11px] leading-4 text-text-faint">
                {progress.currentPath}
              </p>
            )}
          </SettingBlock>
        </SettingGroup>
      )}

      <SettingGroup title={t('settings.cache')} description={t('settings.cacheDesc')}>
        <SettingRow
          label={t('settings.cacheSize')}
          description={t('settings.cacheSizeDesc')}
          control={
            usage.state === 'loading' ? (
              <Skeleton className="h-5 w-28" rounded="sm" />
            ) : usage.state === 'error' ? (
              <Button variant="ghost" size="sm" onClick={loadUsage}>
                {t('settings.retry')}
              </Button>
            ) : (
              <span className="font-num text-sm tabular-nums text-text">
                {formatBytes(usage.value.cacheBytes + usage.value.offlineBytes, lang)}
              </span>
            )
          }
        />
        <SettingRow
          label={t('settings.maxCache')}
          description={t('settings.maxCacheDesc')}
          control={
            <div className="flex w-full items-center gap-3 sm:w-64">
              <Slider
                className="flex-1"
                label={t('settings.maxCache')}
                value={cacheGb}
                min={MIN_CACHE_GB}
                max={MAX_CACHE_GB}
                step={1}
                onChange={setCacheGb}
                onCommit={(v) => patch({ maxCacheBytes: Math.round(v) * GB })}
              />
              <span className="w-20 shrink-0 text-right font-num text-xs tabular-nums text-text-dim">
                {formatBytes(cacheGb * GB, lang)}
              </span>
            </div>
          }
        />
        <SettingRow
          label={t('settings.clearCache')}
          description={t('settings.clearCacheDesc')}
          danger
          control={
            <Button variant="danger" size="sm" onClick={() => setConfirmClear(true)}>
              {t('settings.clearCache')}
            </Button>
          }
        />
      </SettingGroup>

      <SettingGroup title={t('settings.stats')}>
        <SettingBlock>
          {stats.state === 'loading' ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16" rounded="md" />
              ))}
            </div>
          ) : stats.state === 'error' ? (
            <ErrorBanner
              title={t('settings.statsFailed')}
              tone="warn"
              onRetry={loadStats}
            />
          ) : stats.value.tracks === 0 ? (
            <EmptyState
              title={t('settings.statsEmpty')}
              body={t('settings.statsEmptyBody')}
              action={
                local === undefined
                  ? undefined
                  : { label: t('settings.addFolder'), onClick: addFolder }
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Figure label={t('settings.statTracks')} value={String(stats.value.tracks)} />
              <Figure label={t('settings.statAlbums')} value={String(stats.value.albums)} />
              <Figure label={t('settings.statArtists')} value={String(stats.value.artists)} />
              <Figure label={t('settings.statPlaylists')} value={String(stats.value.playlists)} />
              <Figure
                label={t('settings.statDuration')}
                value={formatDurationLong(stats.value.totalDurationMs, lang)}
              />
            </div>
          )}
        </SettingBlock>
      </SettingGroup>

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        dismissible={!clearing}
        title={t('settings.clearCacheConfirm')}
        description={t('settings.clearCacheConfirmBody')}
        size="sm"
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)} disabled={clearing}>
              {t('settings.cancel')}
            </Button>
            <Button variant="danger" onClick={clearCache} loading={clearing}>
              {t('settings.clearCache')}
            </Button>
          </>
        }
      />

      {add.errorsDialog}
    </div>
  );
}
