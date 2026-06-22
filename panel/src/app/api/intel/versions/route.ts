import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { intelVersions } from '@/lib/intel/storage';
import { diffVersions } from '@/lib/intel/versioning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const a = url.searchParams.get('from');
  const b = url.searchParams.get('to');
  if (a && b) {
    try {
      const d = await diffVersions(Number(a), Number(b));
      return NextResponse.json({ diff: d });
    } catch {
      return NextResponse.json({ error: 'version_not_found' }, { status: 404 });
    }
  }
  const v = await intelVersions();
  const list = await v.find({}, { projection: { snapshot: 0 } }).sort({ version: -1 }).limit(50).toArray();
  return NextResponse.json({
    versions: list.map(x => ({ ...x, _id: undefined, id: String(x._id) })),
  });
}
