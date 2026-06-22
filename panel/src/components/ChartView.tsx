'use client';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend,
} from 'recharts';

export interface ChartDisplay {
  kind: 'bar' | 'line' | 'pie' | 'area';
  xField?: string;
  yField?: string;
  seriesField?: string;
  title?: string;
}

// Palette aligned with refined indigo/violet brand + status colors.
const COLORS = ['#818cf8', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#f472b6', '#a3e635'];
const GRID  = '#26262e';
const AXIS  = '#8a8a93';
const TOOLTIP_STYLE = {
  background: 'rgba(16,16,19,0.96)',
  border: '1px solid #33333d',
  borderRadius: '8px',
  boxShadow: '0 12px 32px -8px rgba(0,0,0,0.7)',
  color: '#f4f4f7',
  fontSize: 12,
} as const;

function pickFields(rows: Record<string, unknown>[], d: ChartDisplay): { x: string; y: string } | null {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  const x = d.xField && keys.includes(d.xField) ? d.xField : keys[0];
  const numeric = keys.find(k => typeof rows[0][k] === 'number' && k !== x);
  const y = d.yField && keys.includes(d.yField) ? d.yField : numeric ?? keys[1] ?? keys[0];
  if (!x || !y) return null;
  return { x, y };
}

function normalize(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(r => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v instanceof Date ? v.toISOString().slice(0, 10) :
        (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
    }
    return out;
  });
}

export function ChartView({ rows, display }: { rows: Record<string, unknown>[]; display: ChartDisplay }) {
  const fields = pickFields(rows, display);
  if (!fields) return <div className="text-muted text-sm">Not enough data to render chart.</div>;
  const data = normalize(rows);
  const { x, y } = fields;

  const common = (
    <>
      <CartesianGrid strokeDasharray="2 4" stroke={GRID} vertical={false} />
      <XAxis dataKey={x} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
      <YAxis tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} width={48} />
      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(99,102,241,0.06)' }} />
      <Legend wrapperStyle={{ color: AXIS, fontSize: 12, paddingTop: 8 }} iconType="circle" />
    </>
  );

  return (
    <div className="card card-pad">
      {display.title && <div className="h-sect mb-3">{display.title}</div>}
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          {display.kind === 'bar' ? (
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {common}
              <defs>
                <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818cf8" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0.7} />
                </linearGradient>
              </defs>
              <Bar dataKey={y} fill="url(#barFill)" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : display.kind === 'line' ? (
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {common}
              <Line type="monotone" dataKey={y} stroke="#818cf8" strokeWidth={2}
                dot={false} activeDot={{ r: 4, fill: '#818cf8', stroke: '#0a0a0c', strokeWidth: 2 }} />
            </LineChart>
          ) : display.kind === 'area' ? (
            <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {common}
              <defs>
                <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818cf8" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey={y} stroke="#818cf8" strokeWidth={2} fill="url(#areaFill)" />
            </AreaChart>
          ) : (
            <PieChart>
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ color: AXIS, fontSize: 12, paddingTop: 8 }} iconType="circle" />
              <Pie data={data} dataKey={y} nameKey={x} outerRadius={110} innerRadius={60}
                stroke="#0a0a0c" strokeWidth={2} paddingAngle={2}>
                {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
