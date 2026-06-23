import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// We intentionally do NOT use `next/font/google` here: it forces a build-time
// download from fonts.gstatic.com, which fails in restricted-network Docker
// builds with "socket hang up" and stalls the pipeline. The `--font-sans` /
// `--font-mono` CSS variables (consumed by tailwind.config.ts) are defined as
// pure system-font stacks in globals.css, which look excellent on every
// modern OS and need no network round-trip.

export const metadata: Metadata = {
  title: 'Paklean BI',
  description: 'Internal BI & reporting panel',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
