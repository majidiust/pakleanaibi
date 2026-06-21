import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { requireUser } from '@/lib/auth';
import { biDb } from '@/lib/mongo';
import { buildOtpAuthUri, buildQrDataUrl, generateSecret } from '@/lib/totp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Generates a fresh secret and stores it as a *pending* secret on the user
// document. It only becomes the active secret after /enable confirms a code,
// so an interrupted setup doesn't lock the user out.
export async function POST() {
  let me;
  try { me = await requireUser(); } catch (r) { return r as Response; }
  const secret = generateSecret();
  const uri = buildOtpAuthUri(me.email, secret);
  const qrDataUrl = await buildQrDataUrl(uri);

  const db = await biDb();
  await db.collection('users').updateOne(
    { _id: new ObjectId(me.sub) },
    { $set: { totpPendingSecret: secret, totpPendingSetAt: new Date() } },
  );

  return NextResponse.json({ secret, uri, qrDataUrl });
}
