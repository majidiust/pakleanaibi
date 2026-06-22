import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { RelationshipsClient } from './RelationshipsClient';

export const dynamic = 'force-dynamic';

export default async function RelationshipsPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  return <RelationshipsClient role={u.role} />;
}
