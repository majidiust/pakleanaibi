import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { requireUser } from '@/lib/auth';
import { biDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Lightweight introspection for the /account UI so it can show the right
// enable/disable affordances without exposing the secret itself.
export async function GET() {
  let me;
  try { me = await requireUser(); } catch (r) { return r as Response; }
  const db = await biDb();
  const user = await db.collection('users').findOne(
    { _id: new ObjectId(me.sub) },
    { projection: { totpEnabled: 1, totpEnrolledAt: 1, totpPendingSecret: 1 } },
  );
  return NextResponse.json({
    enabled: user?.totpEnabled === true,
    enrolledAt: user?.totpEnrolledAt ?? null,
    setupInProgress: !!user?.totpPendingSecret,
  });
}
