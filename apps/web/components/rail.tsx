'use client';

import { can, type Workspace } from '@saas/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The rail's navigation. A client component only for `usePathname`, so the
 * current page carries `aria-current="page"` (and the tenant's accent marker
 * that globals.css hangs on it).
 *
 * Links a role cannot use are not shown: an analyst has no billing page to
 * visit. The API refuses the requests anyway; this keeps the rail honest.
 */
export function RailNav({ workspace }: { readonly workspace: Workspace }) {
  const path = usePathname();
  const base = `/w/${workspace.slug}`;
  const links: { href: string; label: string; show: boolean; exact?: boolean }[] = [
    { href: base, label: 'Dashboards', show: true, exact: true },
    {
      href: `${base}/settings/members`,
      label: 'Members',
      show: can(workspace.role, 'member.read'),
    },
    { href: `${base}/settings/keys`, label: 'API keys', show: can(workspace.role, 'apikey.read') },
    {
      href: `${base}/settings/billing`,
      label: 'Plan & billing',
      show: can(workspace.role, 'billing.read'),
    },
    {
      href: `${base}/settings/branding`,
      label: 'Branding',
      show: can(workspace.role, 'branding.write'),
    },
  ];
  const current = (href: string, exact?: boolean) =>
    exact ? path === href || path.startsWith(`${base}/d/`) : path.startsWith(href);
  return (
    <nav className="nav" aria-label="Workspace">
      {links
        .filter((l) => l.show)
        .map((l, i) => (
          <span key={l.href} style={{ display: 'contents' }}>
            {i === 1 ? <p className="nav-heading">Settings</p> : null}
            <Link
              className="nav-link"
              href={l.href}
              aria-current={current(l.href, l.exact) ? 'page' : undefined}
            >
              {l.label}
            </Link>
          </span>
        ))}
    </nav>
  );
}
