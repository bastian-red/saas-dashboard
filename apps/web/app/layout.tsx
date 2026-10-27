import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The document, the three typefaces, and the skip link.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits
 * the session opts every route into dynamic rendering. Pages and the workspace
 * layout read it themselves (`lib/session.ts`).
 *
 * The faces:
 *
 * - **Space Grotesk** for headings, lane titles and the hero numbers: a
 *   geometric grotesque drawn from a monospace ancestor, so a figure at 34px
 *   reads like an instrument's display rather than a headline.
 * - **Atkinson Hyperlegible Next** for every piece of chrome: drawn by the
 *   Braille Institute so 1/l/I and 0/O never collide, which matters in a page
 *   made of counts, event names and property values.
 * - **Fira Code** for what is typed exactly: event names, property tokens in
 *   the sentence editor, API keys, the curl example.
 *
 * **Self-hosted, not fetched from Google at build time.** `next/font/google`
 * downloads the faces during `next dev` and `next build`, and Turbopack's
 * Google-font resolver failed intermittently on a CI runner ("Can't resolve
 * '@vercel/turbopack-next/internal/font/google/font'") while passing locally.
 * A build that depends on a third-party fetch is not reproducible, so the
 * three variable woff2 files (latin subset, exactly the weights used) live in
 * `app/fonts/<Face>/` beside their SIL Open Font License. Docker builds need no
 * network for fonts either.
 *
 * The face names are the directory names (`Space_Grotesk`), the same
 * spelling the Google loaders used. `lib/identity.test.ts` and
 * `web/scripts/identity-distinct.mjs` read them from the `./fonts/<Face>/`
 * paths below, so this file stays the one source of truth.
 */
const display = localFont({
  src: [
    {
      path: './fonts/Space_Grotesk/SpaceGrotesk-latin-wght.woff2',
      weight: '300 700',
      style: 'normal',
    },
  ],
  display: 'swap',
  variable: '--font-display',
});

const ui = localFont({
  src: [
    {
      path: './fonts/Atkinson_Hyperlegible_Next/AtkinsonHyperlegibleNext-latin-wght.woff2',
      weight: '200 800',
      style: 'normal',
    },
  ],
  display: 'swap',
  variable: '--font-ui',
});

const mono = localFont({
  src: [
    { path: './fonts/Fira_Code/FiraCode-latin-wght.woff2', weight: '300 700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: { default: 'saas-dashboard', template: '%s | saas-dashboard' },
  description:
    'Product analytics for teams: send events, line them up on one time axis, and read every lane at the same instant.',
  robots: { index: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
