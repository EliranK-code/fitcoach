"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function WeightChart({ data }: { data: { date: string; kg: number }[] }) {
  if (data.length < 2) {
    return <p className="text-sm text-slate-500">{data.length === 1 ? `שקילה אחת: ${data[0]!.kg} ק"ג` : "עוד אין שקילות."}</p>;
  }
  const values = data.map((d) => d.kg);
  const min = Math.floor(Math.min(...values) - 1);
  const max = Math.ceil(Math.max(...values) + 1);
  return (
    // Charts read left-to-right (time flows forward); the surrounding page stays RTL.
    <div dir="ltr" className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(d: string) => d.slice(5).split("-").reverse().join("/")} />
          <YAxis domain={[min, max]} tick={{ fontSize: 11, fill: "#64748b" }} />
          <Tooltip formatter={(v) => [`${v} ק"ג`, "משקל"]} labelFormatter={(d) => String(d).split("-").reverse().join("/")} />
          <Line type="monotone" dataKey="kg" stroke="#059669" strokeWidth={2.5} dot={{ r: 3, fill: "#059669" }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
