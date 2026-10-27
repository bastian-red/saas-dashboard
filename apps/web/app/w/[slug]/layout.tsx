import type { CSSProperties, ReactNode } from 'react';

import { Brand } from '../../../components/brand';
import { RailNav } from '../../../components/rail';
import { TzSync } from '../../../components/tz-sync';
import { viewerTimeZone } from '../../../lib/viewer';
import { brandingStyle, listWorkspaces, requireWorkspace } from '../../../lib/workspace';
import { signOutAction } from '../../(auth)/actions';

/**
 * Every workspace page: the rail (switcher, navigation, account) and the work
 * area. The tenant's branding is applied HERE and only here, as six inline
 * custom properties on the shell; globals.css decides which marks wear them.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { user, workspace } = await requireWorkspace(slug, `/w/${slug}`);
  const [all, tz] = await Promise.all([listWorkspaces(user), viewerTimeZone()]);
  const monogram = workspace.name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className="shell"
      data-branded={workspace.branding === null ? undefined : 'true'}
      style={brandingStyle(workspace) as CSSProperties | undefined}
    >
      <TzSync rendered={tz} />
      <aside className="rail">
        <Brand href="/" />
        <details className="switcher">
          <summary aria-label={`Workspace: ${workspace.name}. Switch workspace`}>
            <span className="ws-mark" aria-hidden="true">
              {monogram}
            </span>
            <span className="switcher-name">
              <strong>{workspace.name}</strong>
              <span>
                {workspace.role} · {workspace.plan}
              </span>
            </span>
            <span className="switcher-caret" aria-hidden="true">
              ▾
            </span>
          </summary>
          <ul className="switcher-menu">
            {all.map((w) => (
              <li key={w.id}>
                <a href={`/w/${w.slug}`} aria-current={w.id === workspace.id ? 'true' : undefined}>
                  <span>{w.name}</span>
                  <span className="role">{w.role}</span>
                </a>
              </li>
            ))}
            <li>
              <a href="/w/new">+ New workspace</a>
            </li>
          </ul>
        </details>
        <RailNav workspace={workspace} />
        <div className="rail-foot">
          <span>
            {user.name}
            <br />
            <span className="muted">{user.email}</span>
          </span>
          <form action={signOutAction}>
            <button className="button button-quiet button-small" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main id="main" className="work">
        {children}
      </main>
    </div>
  );
}
