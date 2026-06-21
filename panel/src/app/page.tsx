import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const u = await currentUser();
  redirect(u ? '/dashboard' : '/login');
}
