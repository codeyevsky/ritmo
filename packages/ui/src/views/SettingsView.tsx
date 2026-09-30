import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';

import { Tabs } from '../components/Tabs';
import { useServices } from '../services';
import { useTranslation } from '../hooks/useTranslation';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DataSection } from './settings/DataSection';
import { DesktopSection } from './settings/DesktopSection';
import { EqualizerSection } from './settings/EqualizerSection';
import { IntegrationsSection } from './settings/IntegrationsSection';
import { LibrarySection } from './settings/LibrarySection';
import { NetworkSection } from './settings/NetworkSection';
import { PlaybackSection } from './settings/PlaybackSection';
import { SourcesSection } from './settings/SourcesSection';

const SECTION_IDS = [
  'appearance',
  'playback',
  'equalizer',
  'library',
  'network',
  'sources',
  'integrations',
  'desktop',
  'data',
  'about',
] as const;

export type SettingsSectionId = (typeof SECTION_IDS)[number];

const TITLE_KEYS = {
  appearance: 'settings.appearance',
  playback: 'settings.playback',
  equalizer: 'settings.equalizer',
  library: 'settings.library',
  network: 'settings.network',
  sources: 'settings.sources',
  integrations: 'settings.integrations',
  desktop: 'settings.desktop',
  data: 'settings.data',
  about: 'settings.about',
} as const;

const DEFAULT_SECTION: SettingsSectionId = 'appearance';

/**
 * How far below the top of the scroll port a heading has to travel before that
 * section counts as the one being read. Also the top edge of the observer's
 * band, so "in view" and "active" mean the same thing.
 */
const SPY_BAND_TOP_PX = 88;
/** Bottom edge of the same band, as a share of the port's height. */
const SPY_BAND_BOTTOM = '-65%';
/** Mirrors the sections' `scroll-mt-4`, so a click lands where the CSS says. */
const JUMP_OFFSET_PX = 16;

/**
 * Failsafe for the spy lock. The last section can be too short for its top to
 * ever reach the band, and WebKitGTK does not implement `scrollend`, so the
 * lock can never depend on arriving anywhere.
 */
const JUMP_TIMEOUT_MS = 1200;
/** No scroll event for this long means the scroll has come to rest. */
const SCROLL_IDLE_MS = 120;
/** Slack for "the port is where the jump asked it to be", in px. */
const ARRIVAL_SLACK_PX = 2;

function isSectionId(value: string | undefined): value is SettingsSectionId {
  return value !== undefined && (SECTION_IDS as readonly string[]).includes(value);
}

function renderSection(id: SettingsSectionId): ReactNode {
  switch (id) {
    case 'appearance':
      return <AppearanceSection />;
    case 'playback':
      return <PlaybackSection />;
    case 'equalizer':
      return <EqualizerSection />;
    case 'library':
      return <LibrarySection />;
    case 'network':
      return <NetworkSection />;
    case 'sources':
      return <SourcesSection />;
    case 'integrations':
      return <IntegrationsSection />;
    case 'desktop':
      return <DesktopSection />;
    case 'data':
      return <DataSection />;
    case 'about':
      return <AboutSection />;
  }
}

/**
 * The nearest scrollable ancestor. The shell scrolls `#ritmo-main`, not the
 * document, so that element — and not the viewport — is both what a click has
 * to move and what the observer has to watch.
 */
function scrollPort(el: HTMLElement): HTMLElement | undefined {
  let node = el.parentElement;
  while (node !== null) {
    const overflow = window.getComputedStyle(node).overflowY;
    const scrollable = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
    if (scrollable && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return undefined;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function SettingsView() {
  const { t } = useTranslation();
  const { host } = useServices();
  const params = useParams<{ section?: string }>();
  const navigate = useNavigate();

  const sections = useMemo<readonly SettingsSectionId[]>(
    () =>
      host.platform === 'desktop'
        ? SECTION_IDS
        : SECTION_IDS.filter((id) => id !== 'desktop'),
    [host.platform],
  );

  const requested = params.section;
  const active: SettingsSectionId =
    isSectionId(requested) && sections.includes(requested) ? requested : DEFAULT_SECTION;

  const nodes = useRef(new Map<SettingsSectionId, HTMLElement>());
  const activeRef = useRef(active);
  activeRef.current = active;

  /**
   * Set while a click-driven scroll is in flight. Without it the spy sees every
   * section the animation travels through, rewrites the active one on each, and
   * each rewrite is a fresh reason to scroll — which is what made the nav feel
   * like it was dragging the page back and forth.
   */
  const locked = useRef(false);
  /** Cancels the lock currently in force, whatever armed it. */
  const release = useRef<(() => void) | undefined>(undefined);

  const lockSpy = useCallback((port: HTMLElement | undefined, wanted: number | undefined) => {
    release.current?.();
    locked.current = true;

    const target: EventTarget = port ?? window;
    let idleTimer = 0;

    function unlock(): void {
      window.clearTimeout(idleTimer);
      window.clearTimeout(hardTimer);
      target.removeEventListener('scroll', onScroll);
      target.removeEventListener('scrollend', unlock);
      release.current = undefined;
      locked.current = false;
    }

    function onScroll(): void {
      // Where `scrollend` exists this never gets the chance to fire; where it
      // does not, the lock lifts either on arrival or once the scroll stops.
      if (port !== undefined && wanted !== undefined) {
        const settled = Math.abs(port.scrollTop - wanted) <= ARRIVAL_SLACK_PX;
        const atEnd = port.scrollTop >= port.scrollHeight - port.clientHeight - ARRIVAL_SLACK_PX;
        if (settled || atEnd) {
          unlock();
          return;
        }
      }
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(unlock, SCROLL_IDLE_MS);
    }

    const hardTimer = window.setTimeout(unlock, JUMP_TIMEOUT_MS);
    target.addEventListener('scroll', onScroll, { passive: true });
    target.addEventListener('scrollend', unlock);
    release.current = unlock;
    // A jump to where the port already is emits no scroll event at all.
    onScroll();
  }, []);

  const jump = useCallback(
    (id: SettingsSectionId) => {
      const el = nodes.current.get(id);
      if (el === undefined) return;
      const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
      const port = scrollPort(el);
      if (port === undefined) {
        lockSpy(undefined, undefined);
        el.scrollIntoView({ behavior, block: 'start' });
        return;
      }
      const delta = el.getBoundingClientRect().top - port.getBoundingClientRect().top;
      const wanted = Math.max(0, port.scrollTop + delta - JUMP_OFFSET_PX);
      lockSpy(port, wanted);
      port.scrollTo({ top: wanted, behavior });
    },
    [lockSpy],
  );

  useEffect(() => () => release.current?.(), []);

  const goTo = useCallback(
    (id: SettingsSectionId) => {
      navigate(`/settings/${id}`);
      jump(id);
    },
    [jump, navigate],
  );

  // Ref callbacks are cached per section so re-rendering does not detach and
  // re-attach every element (which would churn the observer's targets).
  const refCallbacks = useRef(new Map<SettingsSectionId, (el: HTMLElement | null) => void>());
  const register = useCallback((id: SettingsSectionId) => {
    const cached = refCallbacks.current.get(id);
    if (cached !== undefined) return cached;
    const cb = (el: HTMLElement | null) => {
      if (el === null) nodes.current.delete(id);
      else nodes.current.set(id, el);
    };
    refCallbacks.current.set(id, cb);
    return cb;
  }, []);

  // Honour a deep link once. Later URL changes are either the spy's own
  // rewrite or a nav click, both of which manage their own scrolling.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;
    if (isSectionId(requested)) jump(requested);
  }, [jump, requested]);

  // Scroll-spy: which section is actually in view, rather than which one a
  // scroll-position sum says should be — the arithmetic flickered between two
  // answers at every boundary.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const first = [...nodes.current.values()][0];
    const port = first === undefined ? undefined : scrollPort(first);

    // The observer only reports sections whose state *changed*, so what is on
    // screen has to be remembered across callbacks.
    const onScreen = new Set<SettingsSectionId>();

    const current = (): SettingsSectionId | undefined => {
      const band = (port?.getBoundingClientRect().top ?? 0) + SPY_BAND_TOP_PX;
      let candidate: SettingsSectionId | undefined;
      // In document order: the last heading that has already passed the top of
      // the band is the one being read. If none has, it is the first one still
      // below it — what the top of the page shows.
      for (const id of sections) {
        if (!onScreen.has(id)) continue;
        const el = nodes.current.get(id);
        if (el === undefined) continue;
        if (el.getBoundingClientRect().top <= band + 1) candidate = id;
        else if (candidate === undefined) return id;
        else break;
      }
      return candidate;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const raw = entry.target.getAttribute('data-section') ?? undefined;
          if (!isSectionId(raw)) continue;
          if (entry.isIntersecting) onScreen.add(raw);
          else onScreen.delete(raw);
        }
        if (locked.current) return;
        const next = current();
        if (next === undefined || next === activeRef.current) return;
        // Replace, never push: scrolling is not navigation, and a Back button
        // that walked every section the user passed would be unusable. The URL
        // change only repaints the nav — nothing here scrolls.
        navigate(`/settings/${next}`, { replace: true });
      },
      {
        root: port ?? null,
        rootMargin: `-${SPY_BAND_TOP_PX}px 0px ${SPY_BAND_BOTTOM} 0px`,
        threshold: 0,
      },
    );
    for (const el of nodes.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [navigate, sections]);

  const tabItems = sections.map((id) => ({ id, label: t(TITLE_KEYS[id]) }));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight text-text">{t('settings.title')}</h1>
      <p className="mt-1 text-sm text-text-dim">{t('settings.subtitle')}</p>

      <div className="sticky top-0 z-10 -mx-4 mt-4 border-b border-line bg-bg/95 px-4 backdrop-blur sm:-mx-6 sm:px-6 min-[820px]:hidden">
        <Tabs items={tabItems} value={active} onChange={goTo} />
      </div>

      <div className="mt-6 flex gap-8">
        <nav
          aria-label={t('settings.title')}
          className="hidden w-44 shrink-0 min-[820px]:block"
        >
          <ul className="sticky top-4 flex flex-col gap-0.5">
            {sections.map((id) => {
              const current = id === active;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => goTo(id)}
                    className={clsx(
                      'w-full rounded-md px-3 py-2 text-left text-sm transition-colors duration-150 ease-swift',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      current
                        ? 'bg-surface-2 font-medium text-text'
                        : 'text-text-dim hover:bg-surface hover:text-text',
                    )}
                  >
                    {t(TITLE_KEYS[id])}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-10">
          {sections.map((id) => (
            <section
              key={id}
              id={id}
              data-section={id}
              ref={register(id)}
              aria-labelledby={`${id}-heading`}
              className="scroll-mt-4"
            >
              <h2
                id={`${id}-heading`}
                className="mb-3 text-lg font-semibold tracking-tight text-text"
              >
                {t(TITLE_KEYS[id])}
              </h2>
              {renderSection(id)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SettingsView;
