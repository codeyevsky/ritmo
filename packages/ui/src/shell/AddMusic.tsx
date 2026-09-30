import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import type { ImportResult } from '@ritmo/core';

import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { useTranslation } from '../hooks/useTranslation';
import { useServices } from '../services';
import { useLibraryStore } from '../store/library';
import { useSettingsStore } from '../store/settings';

type ImportError = ImportResult['errors'][number];

export interface AddMusicOptions {
  /** Re-run the caller's own list query once new tracks have landed. */
  onAdded?: () => void;
  /**
   * Overrides how an album folder is scanned. `LibrarySection` owns a scan with
   * its own progress row and would otherwise report nothing for this one.
   */
  scan?: (folders: string[]) => void;
}

export interface AddMusicApi {
  /** False where the host has no picker (web, mobile): hide the affordance. */
  canAddSingle: boolean;
  canAddAlbum: boolean;
  busy: boolean;
  addSingle: () => void;
  addAlbum: () => void;
  /**
   * The failing-path list the result toast opens. Every consumer has to render
   * it, or the toast's action leads nowhere.
   */
  errorsDialog: ReactElement;
}

/**
 * The two "add music" actions, as behaviour rather than layout: the library
 * header's add dialog and the settings pane place the buttons differently but
 * must agree on what pressing them does.
 */
export function useAddMusic(opts?: AddMusicOptions): AddMusicApi {
  const { host } = useServices();
  const { t } = useTranslation();
  const { show } = useToast();
  const startScan = useLibraryStore((s) => s.startScan);
  const refreshStats = useLibraryStore((s) => s.refreshStats);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<ImportError[] | undefined>(undefined);

  const local = host.localLibrary;
  const onAdded = opts?.onAdded;
  const scanOverride = opts?.scan;

  const report = useCallback(
    (result: ImportResult) => {
      const failed = result.errors.length;
      const parts: string[] = [];
      if (result.imported > 0) parts.push(t('library.importDone', { count: result.imported }));
      if (result.skipped > 0) parts.push(t('library.importSkipped', { count: result.skipped }));
      show({
        id: 'library-import',
        title: parts.length > 0 ? parts.join(' · ') : t('library.importNone'),
        body: failed > 0 ? t('library.importErrors', { count: failed }) : undefined,
        tone: failed > 0 ? 'warn' : 'success',
        // Errors are never dropped: the toast stays until it is acted on.
        durationMs: failed > 0 ? 0 : 5000,
        action:
          failed > 0
            ? { label: t('library.importErrorsAction'), onClick: () => setErrors(result.errors) }
            : undefined,
      });
    },
    [show, t],
  );

  const addSingle = useCallback(() => {
    // `.bind` rather than a narrowed property access: the members are optional,
    // and the bound copy keeps `this` pointing at the bridge.
    const pick = local?.pickFiles?.bind(local);
    const importFiles = local?.importFiles?.bind(local);
    if (pick === undefined || importFiles === undefined) return;

    setBusy(true);
    void (async () => {
      try {
        const paths = await pick();
        if (paths === undefined || paths.length === 0) return;
        const result = await importFiles(paths);
        report(result);
        await refreshStats();
        onAdded?.();
      } catch (e: unknown) {
        show({
          title: t('library.importFailed'),
          body: e instanceof Error ? e.message : undefined,
          tone: 'danger',
          durationMs: 8000,
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [local, report, refreshStats, onAdded, show, t]);

  const addAlbum = useCallback(() => {
    const pick = local?.pickAlbumFolder?.bind(local);
    if (pick === undefined) return;

    setBusy(true);
    void (async () => {
      try {
        const folder = await pick();
        if (folder === undefined || folder.length === 0) return;
        // Unlike a loose-file import this folder keeps being watched, so it
        // joins the configured roots before the scan starts.
        const settings = useSettingsStore.getState();
        const folders = settings.settings.musicFolders;
        if (!folders.includes(folder)) settings.patch({ musicFolders: [...folders, folder] });
        if (scanOverride !== undefined) scanOverride([folder]);
        else await startScan([folder]);
        onAdded?.();
      } catch (e: unknown) {
        show({
          title: t('errors.scanFailed'),
          body: e instanceof Error ? e.message : undefined,
          tone: 'danger',
          durationMs: 8000,
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [local, scanOverride, startScan, onAdded, show, t]);

  const close = useCallback(() => setErrors(undefined), []);
  const list = errors ?? [];

  const errorsDialog = (
    <Modal
      open={errors !== undefined}
      onClose={close}
      title={t('library.importErrorsTitle')}
      size="lg"
      actions={
        <Button variant="subtle" onClick={close}>
          {t('common.close')}
        </Button>
      }
    >
      <ul className="flex flex-col divide-y divide-line">
        {list.map((entry, i) => (
          // The same path can fail twice in one run, so the index joins the key.
          <li key={`${entry.path}-${i}`} className="flex min-w-0 flex-col gap-1 py-2">
            <span className="mono min-w-0 truncate text-xs text-text" title={entry.path}>
              {entry.path}
            </span>
            <span className="min-w-0 break-words text-xs leading-5 text-danger">
              {entry.message}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );

  return {
    canAddSingle: local?.pickFiles !== undefined && local.importFiles !== undefined,
    canAddAlbum: local?.pickAlbumFolder !== undefined,
    busy,
    addSingle,
    addAlbum,
    errorsDialog,
  };
}
