import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { AgenticClient } from './AgenticClient';

export const dynamic = 'force-dynamic';

// `?fromTemplate=<id>` is the entry point from the Saved Reports page. The
// client fetches the template detail and preloads the pipeline into the
// active report pane so the user can iterate on it conversationally.
export default async function AgenticPage({
  searchParams,
}: { searchParams: { fromTemplate?: string } }) {
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
  const fromTemplate = typeof searchParams?.fromTemplate === 'string' ? searchParams.fromTemplate : undefined;
  return <AgenticClient user={{ name: u.name, email: u.email }} currentUserId={u.sub} initialTemplateId={fromTemplate} />;
}
