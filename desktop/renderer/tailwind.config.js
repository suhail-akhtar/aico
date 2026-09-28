/** A theme colour that still honours Tailwind opacity modifiers. */
const mix = (name) => ({ opacityValue }) => (opacityValue === undefined || opacityValue === '1'
  ? `var(${name})`
  : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`);

/** @type {import('tailwindcss').Config} */
export default {
  content: {
    // Relative to this file: the build runs from desktop/.
    relative: true,
    files: [
      './index.html',
      './src/**/*.{ts,tsx}',
      '../../shared/ui/**/*.{ts,tsx}',
      '../../shared/kit/**/*.{ts,tsx}',
      // Shared panes reused inside desktop pages (git history, changes, trajectory, apps).
      '../../web/src/components/**/*.{ts,tsx}',
    ],
  },
  darkMode: 'class',
  theme: {
    extend: {
      // Colours are CSS variables (the theme is set at runtime), so opacity
      // modifiers like bg-aico-danger/10 are resolved with color-mix().
      colors: {
        aico: {
          bg: mix('--aico-bg'),
          surface: mix('--aico-surface'),
          elevated: mix('--aico-elevated'),
          hover: 'var(--aico-hover)',
          border: 'var(--aico-border)',
          'border-subtle': 'var(--aico-border-subtle)',
          primary: mix('--aico-text-primary'),
          secondary: mix('--aico-text-secondary'),
          muted: mix('--aico-text-muted'),
          accent: mix('--aico-accent'),
          'accent-hover': mix('--aico-accent-hover'),
          'accent-soft': 'var(--aico-accent-soft)',
          'on-accent': mix('--aico-on-accent'),
          code: mix('--aico-code-bg'),
          success: mix('--aico-success'),
          warning: mix('--aico-warning'),
          danger: mix('--aico-danger'),
          info: mix('--aico-info'),
          sidebar: mix('--desk-sidebar'),
          pill: mix('--desk-pill'),
        },
      },
      fontFamily: { sans: ['var(--aico-font)'], mono: ['var(--aico-font-mono)'] },
      maxWidth: { column: 'var(--aico-column)' },
      animation: {
        'spin-slow': 'spin 2s linear infinite',
        'pulse-soft': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'desk-fade 160ms ease-out',
        'pop-in': 'desk-pop 140ms ease-out',
      },
    },
  },
  plugins: [],
};
