import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { CollectionDetailClient } from './CollectionDetailClient';

export const dynamic = 'force-dynamic';

export default async function CollectionDetailPage({ params }: { params: { name: string } }) {
  const u = await currentUser();
  if (!u) redirect('/login');
  return <CollectionDetailClient name={decodeURIComponent(params.name)} role={u.role} />;
}
