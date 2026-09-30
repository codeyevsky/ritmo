/**
 * REFERENCE ONLY — not compiled, not imported.
 *
 * The exact public props of every component in `packages/ui/src/components`.
 * Several agents implement these in parallel and several more consume them, so
 * this file is the single source of truth for names, shapes and defaults.
 * Implement them verbatim; if a component needs another prop, it is additive
 * and optional.
 *
 * Conventions
 *  - Every component accepts `className?: string` merged LAST via `clsx`.
 *  - Anything clickable also accepts the native handlers it forwards.
 *  - `Icon` is `React.ComponentType<{ className?: string }>` — icons live in
 *    `packages/ui/src/icons` as inline SVG components, no icon package.
 */

import type {
  Album, Artist, Artwork, Playlist, Station, Track, Uri, EntityKind,
  RepeatMode, ProviderId, Shelf as ShelfData, LyricLine,
} from '@ritmo/core';

type Icon = React.ComponentType<{ className?: string }>;

// ── primitives ──────────────────────────────────────────────────────────────

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'outline' | 'subtle' | 'danger';   // default 'subtle'
  size?: 'sm' | 'md' | 'lg';                                          // default 'md'
  loading?: boolean;
  leading?: Icon;
  trailing?: Icon;
  full?: boolean;
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: Icon;
  /** Required: becomes aria-label and the tooltip text. */
  label: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';                                   // default 'md'
  active?: boolean;
  tooltip?: boolean;                                                  // default true
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
}

export interface PlayButtonProps {
  playing: boolean;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';                                   // 32 / 40 / 56 / 64 px
  onToggle: () => void;
  label?: string;
  className?: string;
}

export interface LikeButtonProps {
  liked: boolean;
  onToggle: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

export interface SliderProps {
  value: number;
  min?: number;                                                       // default 0
  max?: number;                                                       // default 1
  step?: number;
  disabled?: boolean;
  /** Fires continuously while dragging. */
  onChange: (value: number) => void;
  /** Fires once on release — commit expensive work here. */
  onCommit?: (value: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  /** Secondary fill behind the value, 0..1 — used for the buffered range. */
  buffered?: number;
  label: string;
  orientation?: 'horizontal' | 'vertical';                            // default 'horizontal'
  className?: string;
}

export interface SeekBarProps {
  positionMs: number;
  durationMs: number;
  bufferedMs?: number;
  disabled?: boolean;
  onSeek: (positionMs: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  /** Hides the numeric labels for the compact bar. */
  bare?: boolean;
  className?: string;
}

export interface VolumeControlProps {
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  className?: string;
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
  className?: string;
}

export interface SelectOption<T extends string = string> { value: T; label: string; description?: string; disabled?: boolean }
export interface SelectProps<T extends string = string> {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
  label?: string;
  placeholder?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leading?: Icon;
  trailing?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
  /** Renders a clear button when non-empty. */
  clearable?: boolean;
  onClear?: () => void;
}

export interface TabItem<T extends string = string> { id: T; label: string; count?: number; icon?: Icon }
export interface TabsProps<T extends string = string> {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  variant?: 'underline' | 'pill';                                     // default 'underline'
  className?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

export interface BadgeProps { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'danger'; className?: string }
export interface ChipProps { children: React.ReactNode; selected?: boolean; onClick?: () => void; onRemove?: () => void; className?: string }

export interface TooltipProps { content: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; delayMs?: number; children: React.ReactElement }

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Rendered in the footer, right-aligned. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** Blocks backdrop/Escape dismissal for destructive confirmations. */
  dismissible?: boolean;                                              // default true
}

export interface SheetProps { open: boolean; onClose: () => void; title?: React.ReactNode; children: React.ReactNode }

export interface MenuItemSpec {
  id: string;
  label: string;
  icon?: Icon;
  /** Renders a check mark; used by "Add to playlist". */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** A submenu; mutually exclusive with `onSelect`. */
  items?: MenuItemSpec[];
  onSelect?: () => void;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  separatorBefore?: boolean;
}

export interface DropdownMenuProps {
  items: MenuItemSpec[];
  /** The element that opens the menu; receives ref + aria wiring. */
  children: React.ReactElement;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
}

/** Imperative: one portal, one open menu at a time. Exposed through `useContextMenu`. */
export interface ContextMenuHandle { open(x: number, y: number, items: MenuItemSpec[]): void; close(): void }

export interface ToastSpec {
  id: string;
  title: string;
  body?: string;
  tone?: 'neutral' | 'success' | 'warn' | 'danger';
  /** ms; 0 keeps it until dismissed. */
  durationMs?: number;
  action?: { label: string; onClick: () => void };
  /** 0..1 — renders a progress bar, used by the library scan and downloads. */
  progress?: number;
}

export interface SpinnerProps { size?: 'sm' | 'md' | 'lg'; className?: string }
export interface SkeletonProps { className?: string; rounded?: 'sm' | 'md' | 'lg' | 'full' }
export interface ProgressRingProps { value: number; size?: number; thickness?: number; className?: string }

export interface EmptyStateProps {
  icon?: Icon;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  className?: string;
}

export interface ErrorBannerProps {
  title: string;
  body?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  tone?: 'warn' | 'danger';
  className?: string;
}

export interface MarqueeProps { children: React.ReactNode; className?: string }
export interface ScrollAreaProps { children: React.ReactNode; className?: string; onScrollEnd?: () => void }

// ── media ───────────────────────────────────────────────────────────────────

export interface ArtworkProps {
  artwork?: Artwork;
  /** Rendered size in CSS px — picks the closest source and sets width/height. */
  size: number;
  /** Used for the generated fallback (initials + deterministic gradient). */
  name?: string;
  shape?: 'square' | 'circle';                                        // default 'square'
  rounded?: 'sm' | 'md' | 'lg' | 'none';
  className?: string;
  /** Skips lazy loading for above-the-fold heroes. */
  eager?: boolean;
}

export interface TrackRowProps {
  track: Track;
  /** 1-based; omit to hide the index column. */
  index?: number;
  variant?: 'list' | 'compact' | 'queue' | 'search';                  // default 'list'
  active?: boolean;
  playing?: boolean;
  liked?: boolean;
  offline?: boolean;
  selected?: boolean;
  /** Hides the album column in contexts where it is redundant. */
  hideAlbum?: boolean;
  showArtwork?: boolean;                                              // default true
  onPlay: () => void;
  onToggleLike?: () => void;
  /** Queue rows only: adds a trailing "remove from queue" control. */
  onRemove?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  /** Present only in the queue, where rows are draggable. */
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  menuItems?: MenuItemSpec[];
  className?: string;
}

export interface TrackTableColumn { id: 'index' | 'title' | 'album' | 'added' | 'duration' | 'plays'; sortable?: boolean; width?: string }
export interface TrackTableProps {
  tracks: Track[];
  columns?: TrackTableColumn[];
  currentUri?: Uri;
  playing?: boolean;
  likedSet?: Set<Uri>;
  offlineSet?: Set<Uri>;
  hideAlbum?: boolean;
  sort?: { column: TrackTableColumn['id']; dir: 'asc' | 'desc' };
  onSort?: (column: TrackTableColumn['id']) => void;
  onPlay: (index: number) => void;
  onToggleLike?: (track: Track) => void;
  menuItemsFor?: (track: Track, index: number) => MenuItemSpec[];
  /** Enables Shift/Ctrl range selection and returns the selected set. */
  selectable?: boolean;
  onSelectionChange?: (uris: Set<Uri>) => void;
  /** Called when the viewport nears the end — drives keyset paging. */
  onEndReached?: () => void;
  loading?: boolean;
  emptyState?: React.ReactNode;
  /** Fixed row height in px; required by the virtualiser. Default 56 (list) / 44 (compact). */
  rowHeight?: number;
  className?: string;
}

export interface CardProps {
  kind: 'album' | 'artist' | 'playlist' | 'station';
  title: string;
  subtitle?: string;
  artwork?: Artwork;
  uri: Uri;
  onOpen: () => void;
  onPlay?: () => void;
  playing?: boolean;
  menuItems?: MenuItemSpec[];
  size?: 'sm' | 'md';                                                 // 148 / 180 px
  className?: string;
}

export interface ShelfProps {
  title: string;
  subtitle?: string;
  /** Renders a "Tümünü gör" link when provided. */
  onSeeAll?: () => void;
  children: React.ReactNode;
  className?: string;
}

/** Turns a core `Shelf` into a row of `Card`s; the views use this, not `Shelf` directly. */
export interface ShelfRowProps {
  shelf: ShelfData;
  onOpenItem: (item: ShelfData['items'][number]) => void;
  onPlayItem: (item: ShelfData['items'][number]) => void;
  currentUri?: Uri;
  onSeeAll?: () => void;
}

export interface ProviderBadgeProps { provider: ProviderId; size?: 'sm' | 'md'; withLabel?: boolean; className?: string }

export interface NowPlayingArtProps { track?: Track; size: number; /** Adds the dominant-colour bloom behind the art. */ glow?: boolean; className?: string }

export interface VisualizerProps { /** 0..1 magnitudes, refreshed by the caller. */ getSpectrum: (bins: number) => Float32Array | undefined; bins?: number; active: boolean; className?: string }

export interface LyricsPaneProps {
  lines?: LyricLine[];
  plain?: string;
  positionMs: number;
  onSeek?: (ms: number) => void;
  loading?: boolean;
  source?: string;
  className?: string;
}

// ── shell ───────────────────────────────────────────────────────────────────

export interface TitleBarProps { className?: string }
export interface SidebarProps { className?: string }
export interface NavItemProps { to: string; icon: Icon; activeIcon?: Icon; label: string; collapsed?: boolean; badge?: number }
export interface NowPlayingBarProps { className?: string }
export interface RightPanelProps { className?: string }
export interface QueuePanelProps { className?: string }
export interface FullScreenPlayerProps { open: boolean; onClose: () => void }
export interface CommandPaletteProps { open: boolean; onClose: () => void }
export interface ShortcutsDialogProps { open: boolean; onClose: () => void }

export interface AddToPlaylistMenuProps {
  tracks: Track[];
  /** Rendered as a submenu item list; use with DropdownMenu/ContextMenu. */
  onDone?: () => void;
}

export interface EntityHeroProps {
  kind: EntityKind;
  title: string;
  subtitle?: React.ReactNode;
  /** e.g. "Albüm" / "Çalma Listesi" / "Sanatçı". */
  eyebrow?: string;
  artwork?: Artwork;
  /** Meta line under the title: track count, duration, year. */
  meta?: React.ReactNode;
  playing?: boolean;
  onPlay: () => void;
  onShuffle?: () => void;
  liked?: boolean;
  onToggleLike?: () => void;
  menuItems?: MenuItemSpec[];
  /** Round artwork + no eyebrow, for artists. */
  round?: boolean;
  /** Editable title/description, for owned playlists. */
  editable?: boolean;
  onEdit?: () => void;
  children?: React.ReactNode;
}
