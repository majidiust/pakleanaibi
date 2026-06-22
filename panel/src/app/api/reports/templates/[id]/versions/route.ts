import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { reportTemplates, reportTemplateVersions, oid } from '@/lib/intel/storage';
import type { IntelReportTemplate } from '@/lib/intel/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function canRead(doc: IntelReportTemplate, sub: string): boolean {
  return doc.visibility !== 'private' || doc.createdBy === sub;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireUser(); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const coll = await reportTemplates();
  const doc = await coll.findOne({ _id }, { projection: { visibility: 1, createdBy: 1 } });
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!canRead(doc as IntelReportTemplate, me.sub)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const versions = await reportTemplateVersions();
  const list = await versions.find({ templateId: _id })
    .sort({ version: -1 }).limit(50).toArray();
  return NextResponse.json({
    versions: list.map(v => ({ ...v, _id: undefined, id: String(v._id) })),
  });
}
