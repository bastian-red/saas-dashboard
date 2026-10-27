import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible_Next, Fira_Code, Space_Grotesk } from 'next/font/google';
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
 * ONE import statement, single-quoted, on purpose. `lib/identity.test.ts` and
 * `web/scripts/identity-distinct.mjs` parse it with the same regex.
 */
const display = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
  weight: ['500', '600', '700'],
});

const ui = Atkinson_Hyperlegible_Next({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ui',
  weight: ['400', '600', '700'],
});

const mono = Fira_Code({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  weight: ['400', '500'],
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
