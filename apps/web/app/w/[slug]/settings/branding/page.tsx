import { can } from '@saas/shared';
import { notFound } from 'next/navigation';

import { BrandingForm } from '../../../../../components/branding-form';
import { requireWorkspace } from '../../../../../lib/workspace';

export const metadata = { title: 'Branding' };

/**
 * The workspace accent. It tints four marks and nothing else: the lane rail,
 * primary buttons, the focus ring and the current-page marker. Body text,
 * charts and status colours keep the product palette, so even an accepted
 * colour cannot make a paragraph or a chart unreadable.
 */
export default async function BrandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug, `/w/${slug}/settings/branding`);
  if (!can(workspace.role, 'branding.write')) notFound();
  return (
    <>
      <header className="page-head">
        <div className="page-head-text">
          <span className="crumb">{workspace.name} / Settings</span>
          <h1>Branding</h1>
        </div>
      </header>
      <p className="muted" style={{ marginBottom: '1rem', maxWidth: '44rem' }}>
        Your accent marks the lane rail, primary buttons, the focus ring and the current page in the
        menu. It must reach 4.5:1 against every background it can sit on, in light and dark mode;
        the dark-mode shade is derived for you.
      </p>
      <BrandingForm slug={slug} current={workspace.branding?.light.accent ?? null} />
    </>
  );
}
