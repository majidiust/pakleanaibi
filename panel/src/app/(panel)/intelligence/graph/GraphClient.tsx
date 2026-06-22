'use client';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, MutableRefObject } from 'react';
import * as THREE from 'three';
import SpriteText from 'three-spritetext';
import { IntelTabs, PageHeader, TypeBadge } from '../_ui';

// 3D force-directed graph with always-on text labels and a navigation
// overlay. The previous implementation was a 2D SVG with a hand-rolled
// Fruchterman-Reingold simulation; the codebase still keeps that pattern
// for small static diagrams but for the schema graph the analyst benefits
// from depth cues (clustered communities pop out of the screen) and from
// camera controls (orbit, zoom, recenter).
//
// react-force-graph-3d wraps three.js + three-forcegraph. It must be loaded
// dynamically with ssr:false because WebGL is browser-only.

interface Node {
  id: string; label: string; entity: string; description: string;
  tags: string[]; docCount: number; fieldsCount: number;
  // Coordinates injected by the simulation in-place. Optional because the
  // initial fetch payload doesn't include them.
  x?: number; y?: number; z?: number;
}
interface Edge {
  id: string; source: string | Node; target: string | Node;
  sourceField: string; targetField: string;
  type: string; status: string; confidence: number; color?: string;
}

// Lib's ref shape — the subset of methods we actually call. Avoids dragging
// the full ForceGraphMethods generic + its three.js scene types into this
// file's public surface.
interface FG3DRef {
  cameraPosition(
    pos?: { x?: number; y?: number; z?: number },
    lookAt?: { x: number; y: number; z: number },
    transitionMs?: number,
  ): { x: number; y: number; z: number };
  zoomToFit(durationMs?: number, paddingPx?: number, nodeFilter?: (n: Node) => boolean): void;
  refresh(): void;
  // The three.js controls object (TrackballControls by default) — `.target`
  // is the Vector3 the camera orbits around. We use it to compute zoom that
  // tracks the current pivot instead of always pulling toward origin.
  controls(): { target: { x: number; y: number; z: number } } | undefined;
}

interface ForceGraph3DProps {
  // next/dynamic does NOT forward the special `ref` prop (vercel/next.js#4957
  // & #40769), so we rename it. The lib-wrapping component below feeds this
  // through to the real ForceGraph3D ref.
  forwardedRef?: MutableRefObject<FG3DRef | undefined>;
  graphData: { nodes: Node[]; links: Edge[] };
  width: number; height: number;
  backgroundColor: string;
  nodeThreeObject: (n: Node) => THREE.Object3D;
  nodeThreeObjectExtend?: boolean;
  linkColor: (l: Edge) => string;
  linkOpacity?: number;
  linkWidth: (l: Edge) => number;
  linkDirectionalArrowLength?: number;
  linkDirectionalArrowRelPos?: number;
  linkDirectionalParticles?: (l: Edge) => number;
  linkDirectionalParticleSpeed?: number;
  linkDirectionalParticleColor?: (l: Edge) => string;
  onNodeClick?: (n: Node) => void;
  onBackgroundClick?: () => void;
  onEngineStop?: () => void;
  cooldownTicks?: number;
  warmupTicks?: number;
  enableNodeDrag?: boolean;
}

// next/dynamic + react-force-graph-3d: the lib reaches for `window` at
// import time, so it can only load in the browser. The inline wrapper here
// re-creates ref forwarding (next/dynamic strips the `ref` prop) by reading
// our `forwardedRef` prop and binding it to the real component's `ref`.
const ForceGraph3D = dynamic(
  async () => {
    const Lib = (await import('react-force-graph-3d')).default;
    type LibProps = ForceGraph3DProps;
    function ForceGraph3DWithRef({ forwardedRef, ...rest }: LibProps) {
      // Casts are local to this bridge: the lib's full prop type pulls in
      // three.js generics we don't need elsewhere in the file.
      return <Lib ref={forwardedRef as unknown as never} {...(rest as unknown as object)} />;
    }
    ForceGraph3DWithRef.displayName = 'ForceGraph3DWithRef';
    return ForceGraph3DWithRef;
  },
  { ssr: false, loading: () => <div className="text-muted text-sm p-4">Loading 3D engine…</div> },
) as unknown as ComponentType<ForceGraph3DProps>;

const STATUS_COLORS: Record<string, string> = {
  approved: '#22c55e', manual: '#7c5cff', suggested: '#f59e0b', rejected: '#475569', archived: '#475569',
};

// Per-entity node color so communities pop. Falls back to slate for nodes
// without a tagged entity.
const ENTITY_COLORS: Record<string, string> = {
  identity: '#60a5fa', commerce: '#a78bfa', finance: '#34d399',
  business: '#f59e0b', catalog: '#f472b6', telemetry: '#94a3b8',
  auth: '#fb7185', stateful: '#22d3ee', timestamped: '#cbd5e1',
};
function nodeColor(n: Node, dim: boolean, sel: boolean): string {
  if (sel) return '#7c5cff';
  const c = ENTITY_COLORS[n.entity] ?? '#94a3b8';
  return dim ? '#334155' : c;
}

export function GraphClient() {
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'active' | 'suggested' | 'all'>('active');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<FG3DRef | undefined>(undefined);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    fetch('/api/intel/graph?status=' + statusFilter).then(r => r.json()).then(setData);
  }, [statusFilter]);

  // Track container size so the 3D canvas adapts to layout changes (window
  // resize, sidebar open/close, etc.). The ForceGraph3D component takes
  // explicit width/height props, not flex/relative units.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(320, Math.floor(r.width)), h: Math.max(360, Math.floor(r.height)) });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Match-highlight set. null when the search box is empty so the renderer
  // can short-circuit and avoid dimming everything.
  const matches = useMemo<Set<string> | null>(() => {
    if (!q.trim() || !data) return null;
    const re = new RegExp(q.trim(), 'i');
    return new Set(data.nodes.filter(n => re.test(n.id) || re.test(n.label) || re.test(n.entity)).map(n => n.id));
  }, [q, data]);

  // Adapt the API payload to the lib's expected `links` shape. We pass copies
  // so the simulation can mutate x/y/z on the nodes without surprising React.
  const graphData = useMemo(() => {
    if (!data) return { nodes: [] as Node[], links: [] as Edge[] };
    return {
      nodes: data.nodes.map(n => ({ ...n })),
      links: data.edges.map(e => ({ ...e })),
    };
  }, [data]);

  // Build the per-node three.js object: a coloured sphere sized by docCount
  // plus a SpriteText label that always faces the camera so the analyst can
  // read every node id without hovering. Recomputed when the highlight set
  // or selection changes (the engine calls this lazily on dirty nodes).
  const nodeThreeObject = useCallback((node: Node) => {
    const dim = !!(matches && !matches.has(node.id));
    const sel = selected === node.id;
    const r = 4 + Math.min(8, Math.log10(Math.max(1, node.docCount)) * 1.8);
    const group = new THREE.Group();
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(r, 18, 18),
      new THREE.MeshLambertMaterial({
        color: nodeColor(node, dim, sel),
        opacity: dim ? 0.35 : 1,
        transparent: true,
      }),
    );
    group.add(sphere);
    if (sel) {
      // A faint halo around the selected node — easy visual anchor when the
      // camera flies in from a wide view.
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(r * 1.45, 18, 18),
        new THREE.MeshBasicMaterial({ color: '#7c5cff', opacity: 0.18, transparent: true }),
      );
      group.add(halo);
    }
    const label = new SpriteText(node.id);
    label.color = sel ? '#ffffff' : dim ? '#475569' : '#e2e8f0';
    label.backgroundColor = sel ? '#7c5cff' : 'rgba(15,15,18,0.7)';
    label.padding = 1.4;
    label.fontFace = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    label.fontWeight = sel ? '600' : '400';
    label.textHeight = 3.2 + Math.min(2.8, Math.log10(Math.max(1, node.docCount)) * 0.9);
    label.position.set(0, r + label.textHeight * 0.9, 0);
    group.add(label);
    return group;
  }, [matches, selected]);

  const linkColor = useCallback((l: Edge) => {
    const base = STATUS_COLORS[l.status] ?? '#64748b';
    if (!matches) return base;
    const srcId = typeof l.source === 'string' ? l.source : l.source.id;
    const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
    if (matches.has(srcId) || matches.has(tgtId)) return base;
    return '#1f2937';
  }, [matches]);
  const linkWidth = useCallback((l: Edge) => l.status === 'manual' ? 2.2 : l.status === 'approved' ? 1.4 : 0.8, []);
  // Animated particles along approved/manual links provide a subtle hint of
  // join direction without the clutter of arrow heads in 3D.
  const linkParticles = useCallback(
    (l: Edge) => (l.status === 'manual' || l.status === 'approved') ? 2 : 0, []);

  // Approximate bounding sphere of the current layout. Used to size the
  // top/front view distances so the camera frames the graph regardless of
  // how the simulation has spread out. Falls back to 400 before the engine
  // has run (initial mount, before nodes get x/y/z).
  const layoutRadius = useCallback(() => {
    const ns = graphData.nodes;
    let max = 0;
    for (const n of ns) {
      if (n.x === undefined) continue;
      const r = Math.hypot(n.x, n.y ?? 0, n.z ?? 0);
      if (r > max) max = r;
    }
    return max > 0 ? max : 400;
  }, [graphData.nodes]);

  const recenter = useCallback((nodeId?: string) => {
    const fg = fgRef.current; if (!fg) return;
    if (nodeId) {
      const n = graphData.nodes.find(x => x.id === nodeId);
      if (!n || n.x === undefined) { fg.zoomToFit(700, 60); return; }
      // Position the camera at a fixed offset behind the node along the
      // ray from origin. Using a fixed offset (rather than scaling by node
      // distance) means clicks on near-origin nodes don't end up with the
      // camera intersecting the sphere.
      const dist = 160;
      const len = Math.max(1, Math.hypot(n.x, n.y ?? 0, n.z ?? 0));
      const ratio = (len + dist) / len;
      fg.cameraPosition(
        { x: (n.x ?? 0) * ratio, y: (n.y ?? 0) * ratio, z: (n.z ?? 0) * ratio },
        { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 },
        700,
      );
    } else {
      fg.zoomToFit(700, 60);
    }
  }, [graphData.nodes]);

  // Multiplicative camera dolly along the view ray (camera -> orbit target).
  // Reading `controls().target` keeps zoom correct after the user has panned
  // away from the origin; the earlier implementation scaled position about
  // (0,0,0), which produced sideways drift instead of a true zoom.
  const dolly = useCallback((factor: number) => {
    const fg = fgRef.current; if (!fg) return;
    const cam = fg.cameraPosition();
    const target = fg.controls()?.target ?? { x: 0, y: 0, z: 0 };
    const next = {
      x: target.x + (cam.x - target.x) * factor,
      y: target.y + (cam.y - target.y) * factor,
      z: target.z + (cam.z - target.z) * factor,
    };
    fg.cameraPosition(next, target, 200);
  }, []);

  // Orthogonal preset views. Distance scales with the current layout radius
  // so the framing is sane for both small and large graphs. The tiny ε on
  // the perpendicular axis avoids the gimbal-lock case where the camera's
  // up vector becomes parallel to the view direction.
  const topView = useCallback(() => {
    const fg = fgRef.current; if (!fg) return;
    const d = layoutRadius() * 1.8;
    fg.cameraPosition({ x: 0, y: d, z: 0.01 }, { x: 0, y: 0, z: 0 }, 700);
  }, [layoutRadius]);
  const frontView = useCallback(() => {
    const fg = fgRef.current; if (!fg) return;
    const d = layoutRadius() * 1.8;
    fg.cameraPosition({ x: 0, y: 0, z: d }, { x: 0, y: 0, z: 0 }, 700);
  }, [layoutRadius]);

  if (!data) return <div><IntelTabs /><div className="card card-pad text-muted">Loading graph…</div></div>;
  const selectedNode = data.nodes.find(n => n.id === selected);
  const selectedEdges = selected ? data.edges.filter(e => {
    const s = typeof e.source === 'string' ? e.source : e.source.id;
    const t = typeof e.target === 'string' ? e.target : e.target.id;
    return s === selected || t === selected;
  }) : [];

  return (
    <div>
      <PageHeader title="Knowledge graph" subtitle="3D view of inferred collections and relationships. Drag to orbit, scroll to zoom, right-drag to pan." />
      <IntelTabs />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select className="input w-auto" value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'active' | 'suggested' | 'all')}>
          <option value="active">Approved + manual</option>
          <option value="suggested">Suggested only</option>
          <option value="all">All</option>
        </select>
        <input className="input flex-1 min-w-[200px] max-w-md" placeholder="Search collection / entity…" value={q} onChange={e => setQ(e.target.value)} />
        <span className="text-xs text-muted">{data.nodes.length} nodes · {data.edges.length} edges</span>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-3">
        <div className="card overflow-hidden relative">
          <div ref={containerRef} className="w-full h-[calc(100vh-260px)] min-h-[520px] bg-panel2">
            <ForceGraph3D
              forwardedRef={fgRef as MutableRefObject<FG3DRef | undefined>}
              graphData={graphData}
              width={size.w}
              height={size.h}
              backgroundColor="#0a0a0c"
              nodeThreeObject={nodeThreeObject}
              linkColor={linkColor}
              linkOpacity={0.55}
              linkWidth={linkWidth}
              linkDirectionalParticles={linkParticles}
              linkDirectionalParticleSpeed={0.006}
              linkDirectionalParticleColor={linkColor}
              cooldownTicks={120}
              warmupTicks={60}
              enableNodeDrag
              onNodeClick={n => { setSelected(n.id); recenter(n.id); }}
              onBackgroundClick={() => setSelected(null)}
              onEngineStop={() => { if (!selected) fgRef.current?.zoomToFit(600, 60); }}
            />
          </div>

          {/* Navigation toolbar — absolute over the canvas so the layout
              doesn't shift when buttons get added later. */}
          <div className="absolute top-2 right-2 flex flex-col gap-1 bg-bg/70 backdrop-blur-sm border border-line rounded-lg p-1 shadow-lg">
            <button type="button" className="btn-ghost text-sm px-2 py-1" title="Zoom in"        onClick={() => dolly(0.8)}>＋</button>
            <button type="button" className="btn-ghost text-sm px-2 py-1" title="Zoom out"       onClick={() => dolly(1.25)}>−</button>
            <button type="button" className="btn-ghost text-sm px-2 py-1" title="Fit all"        onClick={() => recenter()}>⤢</button>
            <button type="button" className="btn-ghost text-sm px-2 py-1" title="Center selected" onClick={() => selected && recenter(selected)} disabled={!selected}>◎</button>
            <button type="button" className="btn-ghost text-sm px-2 py-1" title="Top view"       onClick={topView}>⬒</button>
            <button type="button" className="btn-ghost text-sm px-2 py-1" title="Front view"     onClick={frontView}>◧</button>
          </div>

          {/* Legend pinned bottom-left so newcomers can decode the colours. */}
          <div className="absolute bottom-2 left-2 bg-bg/70 backdrop-blur-sm border border-line rounded-lg px-2 py-1.5 text-2xs space-y-0.5">
            <div className="text-muted-2 mb-0.5">Link status</div>
            {Object.entries(STATUS_COLORS).map(([k, c]) => (
              <div key={k} className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5 rounded" style={{ background: c }} />
                <span className="text-muted">{k}</span>
              </div>
            ))}
          </div>
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
                    const s = typeof e.source === 'string' ? e.source : e.source.id;
                    const t = typeof e.target === 'string' ? e.target : e.target.id;
                    const other = s === selected ? t : s;
                    const dir = s === selected ? '→' : '←';
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
