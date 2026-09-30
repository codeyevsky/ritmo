import { useMemo } from 'react';

import { Modal } from '../components';
import { useTranslation } from '../hooks';

/**
 * Every shortcut the app answers to, in the order the help dialog lists them.
 *
 * `useShortcuts` binds from `bindings` and this dialog renders from `chords`,
 * so the two can never describe different keys. Adding a shortcut means adding
 * one entry here plus one `case` in the hook's dispatcher.
 */
export type ShortcutId =
  | 'playPause'
  | 'seek'
  | 'nextPrevious'
  | 'volume'
  | 'mute'
  | 'shuffle'
  | 'repeat'
  | 'like'
  | 'palette'
  | 'focusSearch'
  | 'toggleQueue'
  | 'toggleLyrics'
  | 'fullscreen'
  | 'closeOverlay'
  | 'settings';

export interface ShortcutBinding {
  /** Compared against `KeyboardEvent.key`, case-insensitively. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Signed magnitude for the paired bindings: ms for `seek`, a 0..1 delta for
   * `volume`, ±1 for `nextPrevious`.
   */
  arg?: number;
}

export interface ShortcutSpec {
  id: ShortcutId;
  bindings: ShortcutBinding[];
  /** One chord per accepted key combination; rendered joined by "/". */
  chords: string[][];
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
  { id: 'playPause', bindings: [{ key: ' ' }], chords: [['Space']] },
  {
    id: 'seek',
    bindings: [
      { key: 'ArrowRight', arg: 10_000 },
      { key: 'ArrowLeft', arg: -10_000 },
    ],
    chords: [['→'], ['←']],
  },
  {
    id: 'nextPrevious',
    bindings: [
      { key: 'ArrowRight', shift: true, arg: 1 },
      { key: 'ArrowLeft', shift: true, arg: -1 },
    ],
    chords: [
      ['Shift', '→'],
      ['Shift', '←'],
    ],
  },
  {
    id: 'volume',
    bindings: [
      { key: 'ArrowUp', arg: 0.05 },
      { key: 'ArrowDown', arg: -0.05 },
    ],
    chords: [['↑'], ['↓']],
  },
  { id: 'mute', bindings: [{ key: 'm' }], chords: [['M']] },
  { id: 'shuffle', bindings: [{ key: 's' }], chords: [['S']] },
  { id: 'repeat', bindings: [{ key: 'r' }], chords: [['R']] },
  { id: 'like', bindings: [{ key: 'l' }], chords: [['L']] },
  { id: 'palette', bindings: [{ key: 'k', ctrl: true }], chords: [['Ctrl', 'K']] },
  { id: 'toggleQueue', bindings: [{ key: 'q' }], chords: [['Q']] },
  { id: 'toggleLyrics', bindings: [{ key: 'y' }], chords: [['Y']] },
  { id: 'fullscreen', bindings: [{ key: 'f' }], chords: [['F']] },
  { id: 'closeOverlay', bindings: [{ key: 'Escape' }], chords: [['Esc']] },
];

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

function Chords({ chords }: { chords: string[][] }): JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chords.map((chord, chordIndex) => (
        <span key={chord.join('+')} className="flex items-center gap-1">
          {chordIndex > 0 ? <span className="text-text-faint">/</span> : null}
          {chord.map((token) => (
            <kbd
              key={token}
              className="min-w-[22px] rounded-xs border border-line bg-surface-2 px-1.5 py-0.5 text-center font-num text-[11px] text-text-dim"
            >
              {token}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps): JSX.Element {
  const { t } = useTranslation();

  const columns = useMemo(() => {
    const half = Math.ceil(SHORTCUTS.length / 2);
    return [SHORTCUTS.slice(0, half), SHORTCUTS.slice(half)];
  }, []);

  return (
    <Modal open={open} onClose={onClose} title={t('shortcuts.title')} size="lg">
      <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {columns.map((column, columnIndex) => (
          <dl key={columnIndex} className="flex flex-col">
            {column.map((shortcut) => (
              <div
                key={shortcut.id}
                className="flex items-center justify-between gap-4 border-b border-line/40 py-2 last:border-b-0"
              >
                <dt className="min-w-0 truncate text-sm text-text-dim">
                  {t(`shortcuts.${shortcut.id}`)}
                </dt>
                <dd>
                  <Chords chords={shortcut.chords} />
                </dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
    </Modal>
  );
}
