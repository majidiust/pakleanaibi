import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { VersionsClient } from './VersionsClient';

export const dynamic = 'force-dynamic';

export default async function VersionsPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  if (u.role === 'viewer') {
    return <div className="card card-pad text-sm text-muted">Version history requires analyst or admin role.</div>;
  }
  return <VersionsClient role={u.role} />;
}
