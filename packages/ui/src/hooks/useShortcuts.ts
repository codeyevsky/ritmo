import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RepeatMode } from '@ritmo/core';

import { useServices } from '../services';
import { useLibraryStore } from '../store/library';
import { usePlayerStore } from '../store/player';
import { useUiStore } from '../store/ui';

/**
 * The search field carries this attribute so `Ctrl+F` / `/` can find it from
 * anywhere without the shell threading a ref through every layout.
 */
export const SEARCH_INPUT_ATTR = 'data-ritmo-search';

const SEEK_STEP_MS = 10_000;
const VOLUME_STEP = 0.05;
const REPEAT_CYCLE: RepeatMode[] = ['off', 'all', 'one'];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Installs the global shortcut table on `document`. Returns nothing — the shell
 * calls it once.
 */
export function useShortcuts(): void {
  const { controller } = useServices();
  const navigate = useNavigate();

  useEffect(() => {
    const fire = (p: Promise<unknown>): void => {
      void p.catch(() => {});
    };

    const seekBy = (deltaMs: number): void => {
      const { positionMs, durationMs, current } = usePlayerStore.getState();
      if (!current || current.isLive) return;
      const target = positionMs + deltaMs;
      fire(controller.seek(Math.round(durationMs > 0 ? Math.min(Math.max(0, target), durationMs) : Math.max(0, target))));
    };

    const nudgeVolume = (delta: number): void => {
      const { volume } = usePlayerStore.getState();
      fire(controller.setVolume(Math.min(1, Math.max(0, Number((volume + delta).toFixed(3))))));
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      const ui = useUiStore.getState();

      // Escape is the one key a dialog or a text field does not get to keep.
      if (e.key === 'Escape') {
        if (isTypingTarget(e.target) && e.target instanceof HTMLElement) {
          e.target.blur();
          return;
        }
        if (ui.closeTopLayer()) e.preventDefault();
        return;
      }

      if (isTypingTarget(e.target)) return;
      if (ui.modalOpen()) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        if (e.altKey || e.shiftKey) return;
        switch (e.key.toLowerCase()) {
          case 'k':
            e.preventDefault();
            ui.setPaletteOpen(true);
            return;
          default:
            return;
        }
      }

      if (e.altKey) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (!e.repeat) fire(controller.toggle());
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            if (!e.repeat) fire(controller.next());
          } else {
            seekBy(SEEK_STEP_MS);
          }
          return;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            if (!e.repeat) fire(controller.previous());
          } else {
            seekBy(-SEEK_STEP_MS);
          }
          return;
        case 'ArrowUp':
          e.preventDefault();
          nudgeVolume(VOLUME_STEP);
          return;
        case 'ArrowDown':
          e.preventDefault();
          nudgeVolume(-VOLUME_STEP);
          return;
        default:
          break;
      }

      if (e.shiftKey || e.repeat) return;

      switch (e.key.toLowerCase()) {
        case 'm':
          e.preventDefault();
          fire(controller.setMuted(!usePlayerStore.getState().muted));
          return;
        case 's':
          e.preventDefault();
          fire(controller.setShuffle(!usePlayerStore.getState().shuffle));
          return;
        case 'r': {
          e.preventDefault();
          const at = REPEAT_CYCLE.indexOf(usePlayerStore.getState().repeat);
          fire(controller.setRepeat(REPEAT_CYCLE[(at + 1) % REPEAT_CYCLE.length] ?? 'off'));
          return;
        }
        case 'l': {
          e.preventDefault();
          const current = usePlayerStore.getState().current;
          if (current) void useLibraryStore.getState().toggleLike(current);
          return;
        }
        case 'q':
          e.preventDefault();
          ui.togglePanel('queue');
          return;
        case 'y':
          e.preventDefault();
          // Lyrics live inside Now playing now, so the chord reveals them there.
          ui.showLyrics();
          return;
        case 'f':
          e.preventDefault();
          ui.toggleFullscreen();
          return;
        default:
          return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [controller, navigate]);
}
