import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { biDb } from '@/lib/mongo';
import { verifyCode } from '@/lib/totp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: Request) {
  let me;
  try { me = await requireUser(); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_code' }, { status: 400 });

  const db = await biDb();
  const _id = new ObjectId(me.sub);
  const user = await db.collection('users').findOne({ _id });
  if (!user?.totpPendingSecret) {
    return NextResponse.json({ error: 'no_pending_setup' }, { status: 400 });
  }
  if (!verifyCode(user.totpPendingSecret, parsed.data.code)) {
    return NextResponse.json({ error: 'invalid_code' }, { status: 401 });
  }

  await db.collection('users').updateOne(
    { _id },
    {
      $set: {
        totpSecret: user.totpPendingSecret,
        totpEnabled: true,
        totpEnrolledAt: new Date(),
      },
      $unset: { totpPendingSecret: '', totpPendingSetAt: '' },
    },
  );
  return NextResponse.json({ ok: true });
}
