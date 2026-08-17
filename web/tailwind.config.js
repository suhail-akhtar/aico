/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // The shared components carry their own classes; without this line Tailwind
    // never sees them and every shared component renders unstyled.
    '../shared/ui/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        aico: {
          bg: 'var(--aico-bg)',
          surface: 'var(--aico-surface)',
          elevated: 'var(--aico-elevated)',
          hover: 'var(--aico-hover)',
          border: 'var(--aico-border)',
          'border-subtle': 'var(--aico-border-subtle)',
          primary: 'var(--aico-text-primary)',
          secondary: 'var(--aico-text-secondary)',
          muted: 'var(--aico-text-muted)',
          accent: 'var(--aico-accent)',
          'accent-hover': 'var(--aico-accent-hover)',
          'accent-soft': 'var(--aico-accent-soft)',
          'on-accent': 'var(--aico-on-accent)',
          code: 'var(--aico-code-bg)',
          success: 'var(--aico-success)',
          warning: 'var(--aico-warning)',
          danger: 'var(--aico-danger)',
          info: 'var(--aico-info)',
        },
      },
      fontFamily: {
        sans: ['var(--aico-font)'],
        mono: ['var(--aico-font-mono)'],
      },
      maxWidth: {
        // The reading column, shared by the transcript and the composer so
        // they line up as one element rather than two stacked panels.
        column: 'var(--aico-column)',
      },
      animation: {
        'spin-slow': 'spin 2s linear infinite',
        'pulse-soft': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
