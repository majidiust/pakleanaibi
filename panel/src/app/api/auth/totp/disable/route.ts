import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser, checkPassword } from '@/lib/auth';
import { biDb } from '@/lib/mongo';
import { verifyCode } from '@/lib/totp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  password: z.string().min(1).max(256),
  code: z.string().regex(/^\d{6}$/),
});

// Requires both the user's password and a current TOTP code to disable 2FA.
// Anything weaker would let a hijacked session strip the second factor.
export async function POST(req: Request) {
  let me;
  try { me = await requireUser(); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const db = await biDb();
  const _id = new ObjectId(me.sub);
  const user = await db.collection('users').findOne({ _id });
  if (!user) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!user.totpEnabled || !user.totpSecret) {
    return NextResponse.json({ error: 'not_enabled' }, { status: 400 });
  }
  if (!(await checkPassword(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: 'invalid_password' }, { status: 401 });
  }
  if (!verifyCode(user.totpSecret, parsed.data.code)) {
    return NextResponse.json({ error: 'invalid_code' }, { status: 401 });
  }

  await db.collection('users').updateOne(
    { _id },
    { $set: { totpEnabled: false }, $unset: { totpSecret: '', totpEnrolledAt: '', totpPendingSecret: '', totpPendingSetAt: '' } },
  );
  return NextResponse.json({ ok: true });
}
