/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Every value is a CSS variable so the dark theme can swap the whole
        // palette by redefining them on .dark, rather than needing dark:
        // variants on every element.
        canvas: 'rgb(var(--af-canvas) / <alpha-value>)',
        surface: 'rgb(var(--af-surface) / <alpha-value>)',
        'surface-muted': 'rgb(var(--af-surface-muted) / <alpha-value>)',
        'surface-sunken': 'rgb(var(--af-surface-sunken) / <alpha-value>)',
        hairline: 'rgb(var(--af-hairline) / <alpha-value>)',
        ink: 'rgb(var(--af-ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--af-ink-soft) / <alpha-value>)',
        'ink-faint': 'rgb(var(--af-ink-faint) / <alpha-value>)',
        accent: 'rgb(var(--af-accent) / <alpha-value>)',
        'accent-deep': 'rgb(var(--af-accent-deep) / <alpha-value>)',
        'accent-wash': 'rgb(var(--af-accent-wash) / <alpha-value>)',
        'accent-edge': 'rgb(var(--af-accent-edge) / <alpha-value>)',
        danger: 'rgb(var(--af-danger) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        // The mockup leans on a few precise sub-14px sizes for the mono chrome.
        '2xs': ['10px', { lineHeight: '1.4' }],
        'xs-plus': ['11px', { lineHeight: '1.45' }],
        'sm-minus': ['12.5px', { lineHeight: '1.5' }],
      },
      borderRadius: {
        card: '11px',
        panel: '16px',
      },
      boxShadow: {
        card: '0 6px 18px -10px rgb(20 30 45 / 0.35)',
        panel: '0 30px 60px -30px rgb(20 30 45 / 0.3)',
      },
      keyframes: {
        'af-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'af-pulse': 'af-pulse 1.1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
