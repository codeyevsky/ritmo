# Ritmo UI — design system and view inventory (FROZEN CONTRACT)

The whole interface lives in `packages/ui`. `apps/web` only bootstraps: it
builds the host bridge, engine, registry, library and controller, then renders
`<RitmoApp services={...} />`. Nothing in `packages/ui` may import from
`apps/web`, and nothing may import `@tauri-apps/*` directly — platform access
is only ever through `services.host`.

## Services context

```ts
// packages/ui/src/services.tsx
export interface RitmoServices {
  host: HostBridge;
  engine: AudioEngine;
  registry: ProviderRegistry;
  library: Library;
  packs: Packs;
  bazaar: Bazaar;
  controller: PlaybackController;
  metadata: MetadataService;
  settings: Settings;
}
export const ServicesContext: React.Context<RitmoServices | null>;
export function useServices(): RitmoServices;        // throws outside the provider
export function ServicesProvider(props: { value: RitmoServices; children: React.ReactNode }): JSX.Element;
```

## Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ TitleBar   ← 40px, draggable, back/forward, search, window controls  │
├────────────┬──────────────────────────────────────┬──────────────────┤
│ Sidebar    │ <Outlet/>  main scroll region        │ RightPanel       │
│ 240px      │                                      │ 352px, optional  │
│ (72px      │  Home / Search / Library / Album /    │ Queue | Lyrics | │
│  collapsed)│  Artist / Playlist / Radio / Settings│ NowPlaying       │
├────────────┴──────────────────────────────────────┴──────────────────┤
│ NowPlayingBar  ← 88px, always present once something has been played │
└──────────────────────────────────────────────────────────────────────┘
```
Below 1100px the RightPanel becomes an overlay; below 820px the Sidebar
collapses to icons; below 640px (mobile) the Sidebar becomes a bottom tab bar
and the NowPlayingBar becomes a compact strip that expands to a full-screen
player. Use `useBreakpoint()`, not raw media queries, so the same component
tree serves desktop and Capacitor.

## Design tokens — `packages/ui/src/styles/globals.css`

Colours are `R G B` triplets in custom properties so Tailwind's
`rgb(var(--c-x) / <alpha-value>)` works and the accent can be swapped at
runtime. Define the full light palette on bare `:root`, then override under
`[data-theme='dark']`, `[data-theme='oled']` and
`@media (prefers-color-scheme: dark)` guarded with `:root:not([data-theme='light'])`.

```
--c-bg          dark 10 11 13    oled 0 0 0     light 255 255 255
--c-surface     dark 20 22 26    oled 9 9 11    light 246 247 249
--c-surface-2   dark 28 31 36    oled 17 17 20  light 238 240 244
--c-surface-3   dark 38 42 48    oled 26 26 30  light 228 231 236
--c-line        dark 44 48 55    oled 32 32 36  light 221 224 230
--c-text        dark 244 245 247               light 16 18 22
--c-text-dim    dark 161 167 176               light 94 100 110
--c-text-faint  dark 108 114 124               light 138 144 154
--c-accent      18 226 154  (Ritmo green, matches the app icon)
--c-accent-hover 45 240 172
--c-on-accent   5 32 28
--c-danger      239 83 80
--c-warn        250 176 5
```
Also define `--bar-h: 88px`, `--title-h: 40px`, `--sidebar-w`, `--panel-w`,
`--ease-swift: cubic-bezier(.22,1,.36,1)`, and a `.scrollbar-thin` utility.
Respect `@media (prefers-reduced-motion: reduce)` by zeroing the animation
durations in one block.

Load Inter with `import '@fontsource-variable/inter'` from `apps/web/src/main.tsx`
(self-hosted; the app must start with no network). `font-feature-settings: 'cv11', 'ss01'`
and `font-variant-numeric: tabular-nums` on durations.

## Component inventory — `packages/ui/src/components/`

Every one of these is a real file, typed props, no `any`, forwarded refs where a
parent needs measurement, and `aria-*` where the role is not implicit.

**Primitives** — `Button` (variants `primary | ghost | outline | subtle | danger`,
sizes `sm | md | lg`, `loading`), `IconButton` (with `label` for a11y and an
optional `active` state), `PlayButton` (the big accent circle, `size`, `playing`,
`loading`), `LikeButton`, `Slider` (pointer + keyboard + wheel, `onScrubStart` /
`onScrubEnd` so the player can suspend position updates mid-drag),
`SeekBar` (Slider + buffered track + hover time tooltip), `VolumeControl`,
`Toggle`, `Select`, `Input` (with `leading`/`trailing` slots), `Tabs`,
`SegmentedControl`, `Badge`, `Chip`, `Tooltip` (delay 400ms, flips at viewport
edges), `Modal` (focus trap, Escape, backdrop click, `@keyframes slide-up`),
`Sheet` (mobile bottom sheet), `DropdownMenu`, `ContextMenu` (right-click
anywhere; one portal, one open menu at a time), `Toast` + `ToastHost`,
`Spinner`, `Skeleton`, `ProgressRing`, `EmptyState` (icon + title + body + CTA),
`ErrorBanner`, `ScrollArea`, `Marquee` (scrolls only when the text overflows and
only on hover, and never under `prefers-reduced-motion`).

**Media** — `Artwork` (srcset from `Artwork.sources`, LQIP/`placeholder`
background, graceful fallback to a generated gradient + initials, `loading="lazy"`,
`decoding="async"`), `TrackRow` (index/play-state column, artwork, title +
artists, album, provider badge, like, duration, overflow menu; `variant`
`list | compact | queue | search`; supports multi-select and drag),
`TrackTable` (virtualised with `@tanstack/react-virtual`, sticky header,
column sort, keyboard navigation, range-select with Shift, `Ctrl+A`),
`Card` (`album | artist | playlist | station` shapes; hover reveals a play
button; artist cards are round), `Shelf` (horizontal scroller with
snap, gradient edge masks, and arrow buttons that appear only when scrollable),
`ShelfSkeleton`, `Visualizer` (canvas, reads `engine.getSpectrum`, pauses via
`IntersectionObserver` when off-screen), `LyricsPane` (auto-scroll with the
active line centred, click a line to seek, manual-scroll lock for 4s),
`ProviderBadge`, `NowPlayingArt` (with the dominant-colour glow).

**Shell** — `TitleBar`, `Sidebar`, `SidebarCollections`, `NavItem`,
`NowPlayingBar`, `RightPanel`, `QueuePanel` (drag to reorder via pointer events;
no external dnd library), `FullScreenPlayer`, `CommandPalette` (`Ctrl+K`:
navigate, search, play, toggle settings), `ShortcutsDialog`, `AddToPlaylistMenu`,
`ScanProgressToast`, `OfflineIndicator`.

## Views — `packages/ui/src/views/`

- `HomeView` — time-aware greeting, a "Jump back in" grid of the 6 most recent
  contexts, then every `Shelf` from `registry.shelves()`. Shelves stream in as
  each provider answers; a provider that fails is simply absent (its error goes
  to a dismissible `ErrorBanner`, never a blank page). Empty library + no network
  shows an `EmptyState` whose CTA opens the folder picker.
- `SearchView` — debounced 250ms, `SegmentedControl` for
  All/Tracks/Albums/Artists/Playlists/Radio, "Top result" hero card, recent
  searches from `host.kv` when the box is empty, per-provider failure chips.
- `LibraryView` — tabs Songs/Albums/Artists/Playlists, a `+` in the header that
  opens the add music dialog (single, album, folder), a sort menu, a live filter
  box, grid ↔ list toggle persisted in settings, and the keyset-paged infinite
  scroll from `Repo.listTracks`. The Playlists tab renders `LibraryCollections`,
  which `/library/playlists` resolves to: liked songs, playlists and packs as
  cards with their counts. Downloads live in the track and album overflow menus,
  folder management in Settings › Library.
- `AlbumView` / `ArtistView` / `PlaylistView` — a hero whose background is the
  artwork's dominant colour fading into `--c-bg`, blurred artwork behind it,
  a large `PlayButton`, shuffle, like, download and an overflow menu, then the
  track table. `ArtistView` additionally has top tracks, discography (grouped
  album/single/compilation) and an About section fed by `metadata.enrichArtist`.
  `PlaylistView` supports inline rename/description editing and drag reorder.
- `PackView` (`/packs/:uri`) — the same hero as `PlaylistView` with editable
  name/description/author/cover, and a drag-reorderable list of the pack's
  *entries*. An entry nothing resolves is greyed and struck through with a
  "not available from your sources" badge and a re-resolve action, because a
  pack keeps what it cannot resolve. Export and Publish sit in the overflow
  menu and are disabled off the desktop. Publish opens a dialog with two
  destinations — a folder, or GitHub Pages (disabled, with a pointer to
  Settings, until a token is stored) — and the GitHub path ends on the live
  `index.json` address with Copy and Open.
- `BazaarView` (`/bazaar`) — subscribed sources with their state, last error,
  refresh and remove, plus the combined catalogue as cards. A card opens a
  preview with the pack's own track list and an Install action that reports how
  many entries resolved. See `docs/packs.md` for the trust boundary.
- `LikedSongsView` — a gradient hero, count + total duration, full table.
- `RadioView` — genre chips, country picker (Turkey first), top-voted grid,
  and a "now playing on this station" ICY title line when the engine reports one.
- `QueueView` (also rendered inside `RightPanel`) — Now playing, "Next in queue"
  (user-queued, removable) and "Next from <context>".
- `SettingsView` — sections Appearance / Playback / Equalizer / Library /
  Network / Sources / Integrations / Desktop / Data / About, exactly matching the
  `Settings` type and the `settings.*` i18n keys. The equalizer is a real 10-band
  slider bank with presets, a live curve preview, and a reset. Library shows the
  folder list with add/remove/rescan plus scan progress. Sources lists each
  provider with an enable toggle, a status dot and, for Jamendo, the client-id
  field with a link to the signup page. Data has export/import/reset.
- `NotFoundView`.

## Stores — `packages/ui/src/store/` (zustand)

- `usePlayerStore` — mirrors `PlaybackState` + `QueueSnapshot`, fed by
  `controller.events`; also `scrubbing: boolean` so the SeekBar can own the
  playhead while dragging.
- `useSettingsStore` — the `Settings` object, `patch(partial)` which persists via
  `host.saveSettings` (debounced 400ms) and pushes the relevant values into the
  controller/engine.
- `useLibraryStore` — playlists list, liked set, offline set, scan progress,
  library stats; invalidated by `ritmo://library-changed`.
- `useUiStore` — right-panel tab + visibility, sidebar collapse, full-screen
  player, command palette, toasts, context menu, last route per tab.
- `useSearchStore` — query, results, per-provider status, recent searches.
- `usePacksStore` — the local pack list the sidebar's Packs section renders.

Selectors must be narrow (`usePlayerStore(s => s.positionMs)`), because the
position updates 60×/s and a broad selector would re-render the whole shell.

## Hooks — `packages/ui/src/hooks/`

`useServices`, `usePlayer`, `useQueue`, `useSettings`, `useLibrary`,
`useSearch`, `useShelves`, `useLyrics`, `useDominantColor`, `useBreakpoint`,
`useShortcuts`, `useContextMenu`, `useToast`, `useVirtualRows`,
`useIsLiked`, `useIsOffline`, `usePacks`, `useScanProgress`, `useMediaCommands`,
`useSmoothPosition` (interpolates the 4Hz progress events to 60fps with
`requestAnimationFrame`, and freezes while `scrubbing`), `useTranslation`
(wraps `createT` from `@ritmo/core`).

## Keyboard shortcuts (registered by `useShortcuts`, ignored while typing)

| Key | Action |
|---|---|
| `Space` | play/pause |
| `→` / `←` | seek ±10 s |
| `Shift+→` / `Shift+←` | next / previous track |
| `↑` / `↓` | volume ±5 % |
| `M` | mute |
| `S` | shuffle |
| `R` | cycle repeat |
| `L` | like current track |
| `Ctrl+K` | command palette |
| `Ctrl+F` / `/` | focus search |
| `Q` | toggle queue panel |
| `Y` | toggle lyrics panel |
| `F` | full-screen player |
| `Esc` | close overlay / exit full screen |
| `Ctrl+,` | settings |

## Non-negotiables

- Turkish copy comes exclusively from `createT(settings.language)` — no literal
  strings in components, ever.
- Every list that can exceed ~200 rows is virtualised.
- Every async surface has three states rendered: loading (skeleton, not a
  spinner-on-blank), empty (`EmptyState` with a real next action), error
  (`ErrorBanner` with retry). A thrown provider error must never blank a page.
- Interactive elements are ≥32px on desktop and ≥44px on mobile, reachable by
  keyboard, and visible focus rings use `--c-accent`.
- No `dangerouslySetInnerHTML`. No inline `style` except for computed colours
  and transforms.
