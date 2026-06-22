import { requireRole } from '@/lib/auth';
import { intelColl, intelRels } from '@/lib/intel/storage';
import { toCsv, toYamlDocument } from '@/lib/intel/serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const fmt = (url.searchParams.get('format') ?? 'json').toLowerCase();
  const what = url.searchParams.get('what') ?? 'all';

  const [colls, rels] = await Promise.all([intelColl(), intelRels()]);
  const cDocs = await colls.find({}).toArray();
  const rDocs = await rels.find({}).toArray();
  const payload: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  if (what === 'all' || what === 'collections') {
    payload.collections = cDocs.map(c => ({ ...c, _id: undefined, id: String(c._id) }));
  }
  if (what === 'all' || what === 'relationships') {
    payload.relationships = rDocs.map(r => ({ ...r, _id: undefined, id: String(r._id) }));
  }

  if (fmt === 'csv') {
    // CSV only covers relationships (flat shape); collections are too nested.
    const flat = rDocs.map(r => ({
      fingerprint: r.fingerprint,
      sourceCollection: r.source.collection, sourceField: r.source.field,
      targetCollection: r.target.collection, targetField: r.target.field,
      type: r.type, status: r.status, confidence: r.confidence,
      detection: r.detection, reason: r.reason,
      tags: r.tags.join('|'),
    }));
    return new Response(toCsv(flat), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="intel-relationships.csv"',
      },
    });
  }
  if (fmt === 'yaml' || fmt === 'yml') {
    return new Response(toYamlDocument(payload), {
      headers: {
        'content-type': 'text/yaml; charset=utf-8',
        'content-disposition': 'attachment; filename="intel.yaml"',
      },
    });
  }
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="intel.json"',
    },
  });
}
