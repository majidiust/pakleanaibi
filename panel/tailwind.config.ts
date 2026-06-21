import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b1020',
        panel: '#111733',
        panel2: '#161d3f',
        line: '#222a55',
        ink: '#e6e9f5',
        muted: '#8b93b8',
        accent: '#5b8def',
        accent2: '#7c5cff',
        ok: '#22c55e',
        warn: '#f59e0b',
        err: '#ef4444',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Inter', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
