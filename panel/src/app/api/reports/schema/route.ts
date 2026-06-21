import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSchema } from '@/lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireUser(); } catch (r) { return r as Response; }
  const force = new URL(req.url).searchParams.get('refresh') === '1';
  const digest = await getSchema(force);
  return NextResponse.json({ digest });
}
