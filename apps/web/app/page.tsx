import { redirect } from 'next/navigation';

import { requireUser } from '../lib/session';
import { listWorkspaces } from '../lib/workspace';

/** Home is the first workspace you belong to, or creating one. */
export default async function Home() {
  const user = await requireUser('/');
  const workspaces = await listWorkspaces(user);
  redirect(workspaces[0] ? `/w/${workspaces[0].slug}` : '/w/new');
}
