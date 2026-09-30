import { useEffect, useRef } from 'react';

import { useLibraryStore } from '../store/library';
import { useToast } from './useToast';
import type { ToastInput } from './useToast';
import { useTranslation } from './useTranslation';

/**
 * ToastHost replaces a toast that is pushed with an id it already holds, which
 * is how one sticky row can follow a scan from "walking" to "done". The id is
 * not part of its declared input type, so it is attached structurally.
 */
function withId(spec: ToastInput, id: string | undefined): ToastInput {
  return id === undefined ? spec : ({ ...spec, id } as ToastInput);
}

function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Turns the library scan into one sticky progress toast that becomes a summary
 * when the walk finishes. Called once, by the shell.
 */
export function useScanProgress(): void {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();

  const scan = useLibraryStore((s) => s.scan);
  const scanning = useLibraryStore((s) => s.scanning);
  const lastScan = useLibraryStore((s) => s.lastScan);
  const scanError = useLibraryStore((s) => s.scanError);
  const cancelScan = useLibraryStore((s) => s.cancelScan);

  /** Id of the sticky row, so progress updates replace it instead of stacking. */
  const stickyId = useRef<string | undefined>(undefined);

  // `TKey` is a closed union owned by the i18n module; these three live in the
  // library/common groups and a rename there must degrade to showing the key
  // rather than breaking the build.
  const tr = t as (key: string, params?: Record<string, string | number>) => string;

  useEffect(() => {
    if (!scanning || !scan) return;

    const spec: ToastInput = {
      title: tr('library.scanning'),
      body: basename(scan.currentPath),
      // The walking phase has no denominator yet, so no bar is drawn for it.
      progress:
        scan.phase === 'walking' || scan.filesSeen === 0
          ? undefined
          : Math.min(1, scan.filesImported / scan.filesSeen),
      durationMs: 0,
      action: { label: tr('common.cancel'), onClick: () => void cancelScan() },
    };

    stickyId.current = toast(withId(spec, stickyId.current));
  }, [scan, scanning, cancelScan, toast, tr]);

  useEffect(() => {
    if (!lastScan) return;
    if (stickyId.current) {
      dismiss(stickyId.current);
      stickyId.current = undefined;
    }
    toast({
      title: tr('library.scanFound', { count: lastScan.added }),
      tone: lastScan.errors.length > 0 ? 'warn' : 'success',
    });
  }, [lastScan, dismiss, toast, tr]);

  useEffect(() => {
    if (!scanError) return;
    if (stickyId.current) {
      dismiss(stickyId.current);
      stickyId.current = undefined;
    }
    toast({ title: tr('errors.scanFailed'), body: scanError.message, tone: 'danger', durationMs: 8000 });
  }, [scanError, dismiss, toast, tr]);
}
