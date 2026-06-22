import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { GraphClient } from './GraphClient';

export const dynamic = 'force-dynamic';

export default async function GraphPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  return <GraphClient />;
}
