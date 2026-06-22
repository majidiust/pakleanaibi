'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IntelTabs, PageHeader, TypeBadge } from '../_ui';

interface Node { id: string; label: string; entity: string; description: string; tags: string[]; docCount: number; fieldsCount: number }
interface Edge { id: string; source: string; target: string; sourceField: string; targetField: string; type: string; status: string; confidence: number; color?: string }
interface Sim { id: string; x: number; y: number; vx: number; vy: number; fx?: number; fy?: number }

const STATUS_COLORS: Record<string, string> = {
  approved: '#22c55e', manual: '#7c5cff', suggested: '#f59e0b', rejected: '#475569', archived: '#475569',
};

export function GraphClient() {
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'active' | 'suggested' | 'all'>('active');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<Map<string, Sim>>(new Map());
  const [, forceRender] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ id?: string; ox: number; oy: number; mode: 'pan' | 'node' } | null>(null);

  useEffect(() => {
    fetch('/api/intel/graph?status=' + statusFilter).then(r => r.json()).then(setData);
  }, [statusFilter]);

  // Build / refresh simulation on data change.
  useEffect(() => {
    if (!data) return;
    const w = 1200, h = 800;
    const map = simRef.current;
    const used = new Set<string>();
    data.nodes.forEach((n, i) => {
      used.add(n.id);
      if (!map.has(n.id)) {
        const a = (i / data.nodes.length) * Math.PI * 2;
        const r = 250 + Math.random() * 50;
        map.set(n.id, { id: n.id, x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r, vx: 0, vy: 0 });
      }
    });
    for (const k of [...map.keys()]) if (!used.has(k)) map.delete(k);
    // Run a few hundred ticks synchronously so the initial layout settles.
    runSimulation(data.nodes, data.edges, map, w, h, 250);
    forceRender(x => x + 1);
  }, [data]);

  // Continuous animation when dragging or when user requests reheat.
  useEffect(() => {
    let raf = 0;
    function tick() {
      if (!data) return;
      if (dragRef.current?.mode === 'node') {
        runSimulation(data.nodes, data.edges, simRef.current, 1200, 800, 1);
        forceRender(x => x + 1);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  const filteredEdges = useMemo(() => {
    if (!data) return [];
    return data.edges;
  }, [data]);

  const matches = useMemo(() => {
    if (!q.trim() || !data) return new Set<string>();
    const re = new RegExp(q.trim(), 'i');
    return new Set(data.nodes.filter(n => re.test(n.id) || re.test(n.label) || re.test(n.entity)).map(n => n.id));
  }, [q, data]);

  function clientToSvg(e: React.PointerEvent) {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM()!;
    const inv = ctm.inverse();
    return pt.matrixTransform(inv);
  }

  function onPointerDown(e: React.PointerEvent, nodeId?: string) {
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = clientToSvg(e);
    if (nodeId) {
      const s = simRef.current.get(nodeId);
      if (s) { s.fx = s.x; s.fy = s.y; }
      dragRef.current = { id: nodeId, ox: p.x, oy: p.y, mode: 'node' };
    } else {
      dragRef.current = { ox: p.x, oy: p.y, mode: 'pan' };
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const p = clientToSvg(e);
    if (dragRef.current.mode === 'node' && dragRef.current.id) {
      const s = simRef.current.get(dragRef.current.id);
      if (s) { s.fx = p.x; s.fy = p.y; s.x = p.x; s.y = p.y; }
    } else {
      setView(v => ({ ...v, x: v.x + (p.x - dragRef.current!.ox) * v.k, y: v.y + (p.y - dragRef.current!.oy) * v.k }));
    }
  }
  function onPointerUp() {
    if (dragRef.current?.id) {
      const s = simRef.current.get(dragRef.current.id);
      if (s) { s.fx = undefined; s.fy = undefined; }
    }
    dragRef.current = null;
  }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView(v => ({ ...v, k: Math.max(0.2, Math.min(3, v.k * delta)) }));
  }

  if (!data) return <div><IntelTabs /><div className="card card-pad text-muted">Loading graph…</div></div>;
  const selectedNode = data.nodes.find(n => n.id === selected);
  const selectedEdges = selected ? data.edges.filter(e => e.source === selected || e.target === selected) : [];

  return (
    <div>
      <PageHeader title="Knowledge graph" subtitle="Interactive visual of inferred collections and relationships. Drag nodes, scroll to zoom." />
      <IntelTabs />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select className="input w-auto" value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'active' | 'suggested' | 'all')}>
          <option value="active">Approved + manual</option>
          <option value="suggested">Suggested only</option>
          <option value="all">All</option>
        </select>
        <input className="input flex-1 min-w-[200px] max-w-md" placeholder="Search collection / entity…" value={q} onChange={e => setQ(e.target.value)} />
        <button className="btn-ghost text-sm" onClick={() => setView({ x: 0, y: 0, k: 1 })}>Reset view</button>
        <span className="text-xs text-muted">{data.nodes.length} nodes · {data.edges.length} edges</span>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-3">
        <div className="card overflow-hidden">
          <svg ref={svgRef} viewBox="0 0 1200 800" className="w-full h-[640px] bg-panel2 select-none"
               onPointerDown={e => onPointerDown(e)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
               onWheel={onWheel}>
            <defs>
              {Object.entries(STATUS_COLORS).map(([k, c]) => (
                <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={c} />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {filteredEdges.map(ed => {
                const s = simRef.current.get(ed.source); const t = simRef.current.get(ed.target);
                if (!s || !t) return null;
                const dim = matches.size > 0 && !matches.has(ed.source) && !matches.has(ed.target);
                const color = STATUS_COLORS[ed.status] ?? '#64748b';
                return (
                  <line key={ed.id} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                        stroke={color} strokeOpacity={dim ? 0.1 : 0.6}
                        strokeWidth={ed.status === 'manual' ? 2.4 : 1.4}
                        strokeDasharray={ed.status === 'suggested' ? '4 3' : undefined}
                        markerEnd={`url(#arrow-${ed.status})`} />
                );
              })}
              {data.nodes.map(n => {
                const s = simRef.current.get(n.id); if (!s) return null;
                const dim = matches.size > 0 && !matches.has(n.id);
                const sel = selected === n.id;
                const r = 8 + Math.min(20, Math.log10(Math.max(1, n.docCount)) * 4);
                return (
                  <g key={n.id} transform={`translate(${s.x},${s.y})`} opacity={dim ? 0.25 : 1}
                     onPointerDown={e => { e.stopPropagation(); onPointerDown(e, n.id); }}
                     onClick={() => setSelected(n.id)} style={{ cursor: 'pointer' }}>
                    <circle r={r} fill={sel ? '#7c5cff' : '#1e293b'} stroke={sel ? '#7c5cff' : '#475569'} strokeWidth={sel ? 2.4 : 1.2} />
                    <text textAnchor="middle" dy={-r - 6} fill="#cbd5e1" fontSize={11} fontFamily="ui-monospace, monospace">{n.id}</text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
        <div className="card card-pad">
          {!selectedNode && <div className="text-sm text-muted">Click a node to see details.</div>}
          {selectedNode && (
            <div className="space-y-3">
              <div>
                <div className="text-xs text-muted">{selectedNode.entity || 'collection'}</div>
                <Link className="link font-mono" href={`/intelligence/collections/${encodeURIComponent(selectedNode.id)}`}>{selectedNode.id}</Link>
              </div>
              <div className="text-sm">{selectedNode.description || <span className="text-muted">No description.</span>}</div>
              <div className="text-xs text-muted">{selectedNode.docCount.toLocaleString()} docs · {selectedNode.fieldsCount} fields</div>
              {selectedNode.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">{selectedNode.tags.map(t => <span key={t} className="pill text-xs">{t}</span>)}</div>
              )}
              <div className="border-t border-line pt-2">
                <div className="text-xs text-muted mb-1">{selectedEdges.length} connections</div>
                <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                  {selectedEdges.map(e => {
                    const other = e.source === selected ? e.target : e.source;
                    const dir = e.source === selected ? '→' : '←';
                    return (
                      <div key={e.id} className="text-xs flex items-center gap-2">
                        <span className="text-muted">{dir}</span>
                        <Link className="link font-mono truncate" href={`/intelligence/collections/${encodeURIComponent(other)}`}>{other}</Link>
                        <TypeBadge type={e.type} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Simple Fruchterman-Reingold-ish force layout. Repulsion between all nodes,
// attraction along edges, gentle centering force.
function runSimulation(nodes: Node[], edges: Edge[], pos: Map<string, Sim>, w: number, h: number, iters: number) {
  const k = 90;            // ideal edge length
  const damp = 0.85;
  const center = { x: w / 2, y: h / 2 };
  const arr = nodes.map(n => pos.get(n.id)!).filter(Boolean);
  for (let it = 0; it < iters; it++) {
    for (const a of arr) { a.vx *= damp; a.vy *= damp; }
    // Repulsion (O(n^2) — fine for small/medium graphs).
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = (k * k) / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f * 0.02; a.vy += (dy / d) * f * 0.02;
        b.vx -= (dx / d) * f * 0.02; b.vy -= (dy / d) * f * 0.02;
      }
    }
    // Attraction along edges.
    for (const e of edges) {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d * d) / k;
      a.vx -= (dx / d) * f * 0.02; a.vy -= (dy / d) * f * 0.02;
      b.vx += (dx / d) * f * 0.02; b.vy += (dy / d) * f * 0.02;
    }
    // Gentle centering.
    for (const a of arr) {
      a.vx += (center.x - a.x) * 0.001;
      a.vy += (center.y - a.y) * 0.001;
    }
    // Integrate; honour fixed pin.
    for (const a of arr) {
      if (a.fx !== undefined && a.fy !== undefined) { a.x = a.fx; a.y = a.fy; continue; }
      a.x += a.vx; a.y += a.vy;
    }
  }
}
