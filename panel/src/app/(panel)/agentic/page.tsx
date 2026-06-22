import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { AgenticClient } from './AgenticClient';

export const dynamic = 'force-dynamic';

export default async function AgenticPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  if (u.role === 'viewer') {
    return (
      <div className="card card-pad">
        <div className="font-medium">Access restricted</div>
        <div className="text-sm text-muted mt-1">Agentic reporting requires analyst or admin role.</div>
      </div>
    );
  }
  return <AgenticClient />;
}
