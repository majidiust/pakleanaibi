import type { Config } from 'tailwindcss';

// Premium dark palette inspired by Linear / Vercel / Stripe Dashboard.
// Neutrals are warm-cool zinc; accent is indigo with violet secondary.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic surface stack (background -> elevated -> hovered).
        bg:       '#0a0a0c',
        panel:    '#101013',
        panel2:   '#16161b',
        panel3:   '#1c1c22',
        line:     '#26262e',
        line2:    '#33333d',
        ink:      '#f4f4f7',
        'ink-2':  '#c9c9d1',
        muted:    '#8a8a93',
        'muted-2':'#5f5f68',
        // Brand
        accent:   '#6366f1', // indigo-500
        accent2:  '#8b5cf6', // violet-500
        'accent-hi': '#818cf8',
        'accent-lo': '#4f46e5',
        // Status
        ok:    '#22c55e',
        warn:  '#f59e0b',
        err:   '#ef4444',
        info:  '#0ea5e9',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'Inter', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      letterSpacing: {
        tightish: '-0.011em',
        tighter2: '-0.025em',
      },
      borderRadius: {
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        'elev-1': '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 1px 2px 0 rgba(0,0,0,0.4)',
        'elev-2': '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 4px 16px -4px rgba(0,0,0,0.55)',
        'elev-3': '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 12px 32px -8px rgba(0,0,0,0.7)',
        'ring-accent': '0 0 0 1px rgba(99,102,241,0.55), 0 0 0 4px rgba(99,102,241,0.18)',
        'btn': '0 1px 0 0 rgba(255,255,255,0.08) inset, 0 1px 2px 0 rgba(0,0,0,0.5)',
      },
      backgroundImage: {
        'gradient-surface': 'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 100%)',
        'gradient-accent':  'linear-gradient(180deg, #6d70f3 0%, #5b5ee0 100%)',
        'gradient-radial-accent':
          'radial-gradient(1000px 500px at 80% -10%, rgba(99,102,241,0.10), transparent 60%)',
      },
      transitionTimingFunction: {
        snappy: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
