import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { CollectionsClient } from './CollectionsClient';

export const dynamic = 'force-dynamic';

export default async function CollectionsPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  return <CollectionsClient role={u.role} />;
}
