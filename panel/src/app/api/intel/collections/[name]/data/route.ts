import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { dataDb } from '@/lib/mongo';
import { intelColl } from '@/lib/intel/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;
const MAX_SKIP = 100_000;

// Recursively convert BSON types into JSON-safe shapes for the wire.
function toPlain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Date) return { __t: 'date', v: v.toISOString() };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown> & { _bsontype?: string };
    if (o._bsontype === 'ObjectId') return { __t: 'oid', v: String(v) };
    if (o._bsontype === 'Decimal128') return { __t: 'dec', v: String(v) };
    if (o._bsontype === 'Long') return { __t: 'long', v: String(v) };
    if (o._bsontype === 'Binary') return { __t: 'bin', v: '<binary>' };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = toPlain(val);
    return out;
  }
  return v;
}

export async function GET(req: Request, { params }: { params: { name: string } }) {
  try { await requireRole('admin', 'analyst', 'viewer'); } catch (r) { return r as Response; }

  // Whitelist: only collections that the intel scan has registered are browsable.
  const colls = await intelColl();
  const meta = await colls.findOne({ name: params.name }, { projection: { name: 1, docCount: 1, fields: 1 } });
  if (!meta) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit') ?? 25) | 0));
  const skip = Math.min(MAX_SKIP, Math.max(0, Number(url.searchParams.get('skip') ?? 0) | 0));
  const sortRaw = (url.searchParams.get('sort') ?? '_id').trim();
  const dir = (url.searchParams.get('dir') ?? '-1') === '1' ? 1 : -1;
  const sortKey = sortRaw.replace(/[^A-Za-z0-9_.]/g, '').slice(0, 80) || '_id';

  const db = await dataDb();
  const coll = db.collection(params.name);

  // Cap counting cost: estimated for total, exact only when explicitly requested.
  const wantExact = url.searchParams.get('exact') === '1';
  const [rows, total] = await Promise.all([
    coll.find({}, { maxTimeMS: 8000 })
      .sort({ [sortKey]: dir })
      .skip(skip)
      .limit(limit)
      .toArray(),
    wantExact
      ? coll.countDocuments({}, { maxTimeMS: 8000 })
      : coll.estimatedDocumentCount(),
  ]);

  return NextResponse.json({
    name: meta.name,
    total,
    totalIsExact: wantExact,
    skip,
    limit,
    sort: { key: sortKey, dir },
    rows: rows.map(r => toPlain(r) as Record<string, unknown>),
  });
}
