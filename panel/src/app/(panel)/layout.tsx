import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentUser } from '@/lib/auth';
import { Sidebar } from '@/components/Sidebar';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  return (
    <div className="flex min-h-screen">
      <Sidebar user={{ name: user.name, email: user.email, role: user.role }} />
      <main className="flex-1 min-w-0">
        <div className="px-6 lg:px-8 py-6 lg:py-8 mx-auto max-w-[1400px] w-full">
          {children}
        </div>
      </main>
    </div>
  );
}
