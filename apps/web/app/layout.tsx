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
 * The faces, from the control room this identity is drawn from (docs/DESIGN.md):
 *
 * - **Sofia Sans Condensed** for lane titles, verdicts and the big figures: a
 *   condensed grotesque, so a roll call of six lanes fits one line and a figure
 *   reads like a console readout, not a headline.
 * - **Chivo** for every piece of chrome: a sturdy grotesque with open
 *   apertures that holds up at 13px in a dense sidebar and a lane menu.
 * - **Chivo Mono** for what is typed exactly: event names, property tokens in
 *   the sentence editor, API keys, the curl example. Its 0 is slashed and its
 *   1/l/I are distinct.
 *
 * **Self-hosted, not fetched from Google at build time.** `next/font/google`
 * downloads the faces during `next dev` and `next build`, and Turbopack's
 * Google-font resolver failed intermittently on a CI runner ("Can't resolve
 * '@vercel/turbopack-next/internal/font/google/font'") while passing locally.
 * A build that depends on a third-party fetch is not reproducible, so the
 * three variable woff2 files (latin subset) live in `app/fonts/<Face>/` beside
 * their SIL Open Font License. Docker builds need no network for fonts either.
 *
 * The face names are the directory names (`Sofia_Sans_Condensed`), the same
 * spelling the Google loaders use. `lib/identity.test.ts` and
 * `web/scripts/identity-distinct.mjs` read them from the `./fonts/<Face>/`
 * paths below, so this file stays the one source of truth.
 */
const display = localFont({
  src: [
    {
      path: './fonts/Sofia_Sans_Condensed/SofiaSansCondensed-latin-wght.woff2',
      weight: '1 1000',
      style: 'normal',
    },
  ],
  display: 'swap',
  variable: '--font-display',
});

const ui = localFont({
  src: [{ path: './fonts/Chivo/Chivo-latin-wght.woff2', weight: '100 900', style: 'normal' }],
  display: 'swap',
  variable: '--font-ui',
});

const mono = localFont({
  src: [
    { path: './fonts/Chivo_Mono/ChivoMono-latin-wght.woff2', weight: '100 900', style: 'normal' },
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

/** The browser chrome matches the canvas in each scheme (`--bg`; identity.test.ts pins both). */
export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#d0d9db' },
    { media: '(prefers-color-scheme: dark)', color: '#050a0b' },
  ],
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
