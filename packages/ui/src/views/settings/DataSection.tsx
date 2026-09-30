import { useState } from 'react';
import { defaultSettings } from '@ritmo/core';

import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useServices } from '../../services';
import { useSettings } from '../../hooks/useSettings';
import { useToast } from '../../hooks/useToast';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingBlock, SettingGroup, SettingRow } from './SettingRow';

type ImportMode = 'merge' | 'replace';

function timestamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function joinPath(dir: string | undefined, file: string): string {
  if (dir === undefined || dir === '') return file;
  return `${dir.replace(/[/\\]+$/, '')}/${file}`;
}

export function DataSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();
  const { host, library } = useServices();
  const toast = useToast();

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const dir = settings.cacheDir;

  const runExport = () => {
    setExporting(true);
    setError(undefined);
    void (async () => {
      try {
        const json = await library.exportAll();
        const path = joinPath(dir, `ritmo-export-${timestamp()}.json`);
        await host.files.writeText(path, json);
        toast.show({
          title: t('settings.exportDone'),
          body: path,
          tone: 'success',
          durationMs: 0,
          // The WebView cannot start a download, so the file is written next to
          // the app data and the user is handed the folder instead.
          ...(dir === undefined
            ? {}
            : {
                action: {
                  label: t('settings.openFolder'),
                  onClick: () => void host.openExternal(`file://${dir}`),
                },
              }),
        });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setExporting(false);
      }
    })();
  };

  const runImport = () => {
    setImporting(true);
    setError(undefined);
    void (async () => {
      try {
        const json = await host.files.readText(importPath.trim());
        await library.importAll(json, { merge: importMode === 'merge' });
        toast.show({ title: t('settings.importDone'), tone: 'success' });
        setImportPath('');
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setImporting(false);
        setConfirmImport(false);
      }
    })();
  };

  const runReset = () => {
    const fresh = defaultSettings();
    // Folder locations describe this machine rather than a preference, so a
    // preferences reset keeps them; wiping them would orphan the scanned
    // library without actually deleting anything.
    patch({
      ...fresh,
      musicFolders: settings.musicFolders,
      cacheDir: settings.cacheDir,
    });
    setConfirmReset(false);
    toast.show({ title: t('settings.resetDone'), tone: 'success' });
  };

  return (
    <div className="flex flex-col gap-4">
      {error !== undefined && (
        <ErrorBanner
          title={t('settings.dataFailed')}
          body={error}
          tone="danger"
          onDismiss={() => setError(undefined)}
        />
      )}

      <SettingGroup title={t('settings.export')} description={t('settings.exportDesc')}>
        <SettingRow
          label={t('settings.exportButton')}
          description={t('settings.exportTarget', { path: joinPath(dir, 'ritmo-export-….json') })}
          control={
            <Button variant="outline" size="sm" loading={exporting} disabled={exporting} onClick={runExport}>
              {t('settings.exportButton')}
            </Button>
          }
        />
      </SettingGroup>

      <SettingGroup title={t('settings.import')} description={t('settings.importDesc')}>
        <SettingRow
          label={t('settings.importPath')}
          description={t('settings.importPathDesc')}
          htmlFor="setting-import-path"
          control={
            <Input
              id="setting-import-path"
              className="w-full sm:w-72"
              size="sm"
              value={importPath}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('settings.importPathPlaceholder')}
              clearable
              onClear={() => setImportPath('')}
              onChange={(e) => setImportPath(e.target.value)}
            />
          }
        />
        <SettingRow
          label={t('settings.importMode')}
          description={
            importMode === 'merge' ? t('settings.importMergeDesc') : t('settings.importReplaceDesc')
          }
          control={
            <SegmentedControl
              items={[
                { id: 'merge', label: t('settings.importMerge') },
                { id: 'replace', label: t('settings.importReplace') },
              ]}
              value={importMode}
              onChange={setImportMode}
            />
          }
        />
        <SettingBlock>
          <Button
            variant="outline"
            size="sm"
            disabled={importPath.trim() === '' || importing}
            onClick={() => setConfirmImport(true)}
          >
            {t('settings.importButton')}
          </Button>
        </SettingBlock>
      </SettingGroup>

      <SettingGroup title={t('settings.reset')} description={t('settings.resetDesc')}>
        <SettingRow
          label={t('settings.resetButton')}
          description={t('settings.resetRowDesc')}
          danger
          control={
            <Button variant="danger" size="sm" onClick={() => setConfirmReset(true)}>
              {t('settings.resetButton')}
            </Button>
          }
        />
      </SettingGroup>

      <Modal
        open={confirmImport}
        onClose={() => setConfirmImport(false)}
        dismissible={!importing}
        size="sm"
        title={t('settings.importConfirm')}
        description={
          importMode === 'replace'
            ? t('settings.importConfirmReplaceBody')
            : t('settings.importConfirmMergeBody')
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmImport(false)} disabled={importing}>
              {t('settings.cancel')}
            </Button>
            <Button
              variant={importMode === 'replace' ? 'danger' : 'primary'}
              loading={importing}
              onClick={runImport}
            >
              {t('settings.importButton')}
            </Button>
          </>
        }
      >
        <p className="break-all font-num text-xs text-text-dim">{importPath}</p>
      </Modal>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        size="sm"
        title={t('settings.resetConfirm')}
        description={t('settings.resetConfirmBody')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              {t('settings.cancel')}
            </Button>
            <Button variant="danger" onClick={runReset}>
              {t('settings.resetButton')}
            </Button>
          </>
        }
      />
    </div>
  );
}
