import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { startJob, latestJob, getJob } from '@/lib/intel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireRole('admin'); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const id = url.searchParams.get('jobId');
  const job = id ? await getJob(id) : await latestJob();
  if (!job) return NextResponse.json({ job: null });
  return NextResponse.json({ job: { ...job, _id: undefined, id: String(job._id) } });
}

export async function POST() {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const job = await startJob(me.sub);
  return NextResponse.json({ id: String(job._id), status: job.status }, { status: 202 });
}
