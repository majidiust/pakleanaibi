import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { TemplatesClient } from './TemplatesClient';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  if (u.role === 'viewer') {
    return (
      <div className="card card-pad">
        <div className="font-medium">Access restricted</div>
        <div className="text-sm text-muted mt-1">Saved reports require analyst or admin role.</div>
      </div>
    );
  }
  return <TemplatesClient currentUserId={u.sub} role={u.role} />;
}
