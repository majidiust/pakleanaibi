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

const COLORS = ['#5b8def', '#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#e879f9', '#84cc16'];

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
      <CartesianGrid strokeDasharray="3 3" stroke="#222a55" />
      <XAxis dataKey={x} tick={{ fill: '#8b93b8', fontSize: 12 }} />
      <YAxis tick={{ fill: '#8b93b8', fontSize: 12 }} />
      <Tooltip contentStyle={{ background: '#111733', border: '1px solid #222a55' }} />
      <Legend />
    </>
  );

  return (
    <div className="card card-pad">
      {display.title && <div className="font-medium mb-2">{display.title}</div>}
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          {display.kind === 'bar' ? (
            <BarChart data={data}>{common}<Bar dataKey={y} fill="#5b8def" /></BarChart>
          ) : display.kind === 'line' ? (
            <LineChart data={data}>{common}<Line type="monotone" dataKey={y} stroke="#5b8def" dot={false} /></LineChart>
          ) : display.kind === 'area' ? (
            <AreaChart data={data}>{common}<Area type="monotone" dataKey={y} stroke="#5b8def" fill="#5b8def33" /></AreaChart>
          ) : (
            <PieChart>
              <Tooltip contentStyle={{ background: '#111733', border: '1px solid #222a55' }} />
              <Legend />
              <Pie data={data} dataKey={y} nameKey={x} outerRadius={110} label>
                {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
