import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { COOKIE, signSession } from '@/lib/auth';
import { biDb } from '@/lib/mongo';
import { verifyPending, verifyCode } from '@/lib/totp';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  pendingToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/),
});

// Second leg of the 2FA login. Consumes the short-lived pending token issued
// by /api/auth/login and exchanges it for a full session cookie on success.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const claims = await verifyPending(parsed.data.pendingToken);
  if (!claims) return NextResponse.json({ error: 'pending_expired' }, { status: 401 });

  const db = await biDb();
  const user = await db.collection('users').findOne({ _id: new ObjectId(claims.sub) });
  if (!user?.totpEnabled || !user.totpSecret) {
    return NextResponse.json({ error: 'totp_not_enabled' }, { status: 400 });
  }
  if (!verifyCode(user.totpSecret, parsed.data.code)) {
    return NextResponse.json({ error: 'invalid_code' }, { status: 401 });
  }

  const token = await signSession({
    sub: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
  });
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: env.JWT_TTL_HOURS * 3600,
  });
  return NextResponse.json({
    user: { id: String(user._id), email: user.email, name: user.name, role: user.role },
  });
}
