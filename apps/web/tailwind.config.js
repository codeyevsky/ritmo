/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"], [data-theme="oled"]'],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // The component library lives outside this app, so Tailwind has to be told
    // to scan it or every class used only in @ritmo/ui gets tree-shaken away.
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Every colour resolves through a CSS custom property so the accent can
        // be recomputed from album art at runtime without rebuilding Tailwind.
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--c-surface-2) / <alpha-value>)',
        'surface-3': 'rgb(var(--c-surface-3) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        text: 'rgb(var(--c-text) / <alpha-value>)',
        'text-dim': 'rgb(var(--c-text-dim) / <alpha-value>)',
        'text-faint': 'rgb(var(--c-text-faint) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--c-accent-hover) / <alpha-value>)',
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['InterVariable', 'Inter', 'system-ui', 'sans-serif'],
        num: ['InterVariable', 'ui-monospace', 'monospace'],
      },
      // Deliberately near-square: the rounded-pill scale is the streaming-app
      // signature this design is moving away from.
      borderRadius: { xs: '2px', sm: '3px', md: '4px', lg: '6px', xl: '8px' },
      spacing: { sidebar: '15rem', 'sidebar-sm': '4.5rem', bar: '5.5rem', panel: '22rem' },
      transitionTimingFunction: { swift: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': { from: { transform: 'translateY(8px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        // The right panel: it has to be obvious that it arrived, so it slides
        // and fades rather than appearing in place.
        'panel-in': { from: { transform: 'translateX(100%)', opacity: '0' }, to: { transform: 'translateX(0)', opacity: '1' } },
        'panel-out': { from: { transform: 'translateX(0)', opacity: '1' }, to: { transform: 'translateX(100%)', opacity: '0' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'bar-bounce': { '0%,100%': { transform: 'scaleY(0.35)' }, '50%': { transform: 'scaleY(1)' } },
        'spin-slow': { to: { transform: 'rotate(360deg)' } },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'slide-up': 'slide-up 200ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-right': 'slide-in-right 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        // `both` so the exit holds its end state for the frames before unmount.
        'panel-in': 'panel-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'panel-out': 'panel-out 180ms cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.6s infinite',
        'spin-slow': 'spin-slow 8s linear infinite',
      },
      boxShadow: {
        card: '0 8px 24px -8px rgb(0 0 0 / 0.5)',
        pop: '0 16px 48px -12px rgb(0 0 0 / 0.65)',
      },
    },
  },
  plugins: [],
}
