import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { ensureBootstrap } from '@/lib/bootstrap';
import { COOKIE, checkPassword, findUserByEmail, signSession } from '@/lib/auth';
import { signPending } from '@/lib/totp';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request) {
  await ensureBootstrap();
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const user = await findUserByEmail(parsed.data.email);
  if (!user) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  const ok = await checkPassword(parsed.data.password, user.passwordHash);
  if (!ok) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });

  // 2FA gate: if enrolled, return a short-lived pending token instead of a
  // full session. The client must POST the 6-digit code to /totp/verify.
  if (user.totpEnabled === true && user.totpSecret) {
    const pendingToken = await signPending({
      sub: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
    });
    return NextResponse.json({ totpRequired: true, pendingToken });
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
