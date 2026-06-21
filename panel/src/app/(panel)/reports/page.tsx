import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { ReportsClient } from './ReportsClient';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  if (u.role === 'viewer') {
    return (
      <div className="card card-pad">
        <div className="font-medium">Access restricted</div>
        <div className="text-sm text-muted mt-1">Reporting requires analyst or admin role.</div>
      </div>
    );
  }
  return <ReportsClient />;
}
