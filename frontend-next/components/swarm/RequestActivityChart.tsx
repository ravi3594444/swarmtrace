'use client'

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { chartTooltip } from '@/lib/chart-tooltip'

export interface ActivityPoint {
  time: string
  requests: number
}

/**
 * Request-activity area chart for the Overview page. Split into its own
 * component (loaded via next/dynamic in app/overview/page.tsx) so recharts
 * — ~492 KB across 3 chunks, per the bundle audit — isn't parsed/executed
 * as part of the page's initial JS, only once this chart actually renders.
 */
export function RequestActivityChart({ activity }: { activity: ActivityPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={activity} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        {/* Reserved accent: this blue is spent nowhere else in the
            dashboard chrome. It's the one moment the palette
            breaks from achromatic — when real trace data starts
            drawing here — so it reads as a distinct, earned
            signal instead of matching every other button/border. */}
        <defs>
          <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-activity-accent)" stopOpacity={0.22} />
            <stop offset="95%" stopColor="var(--chart-activity-accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="time" tick={{ fill: 'var(--muted-foreground)', fontSize: 10, fontWeight: 500 }} axisLine={false} tickLine={false} interval={3} />
        <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11, fontWeight: 500 }} axisLine={false} tickLine={false} width={32} />
        <Tooltip {...chartTooltip} />
        <Area type="monotone" dataKey="requests" stroke="var(--chart-activity-accent)" strokeWidth={2} fill="url(#colorReq)" dot={false} activeDot={{ r: 4, fill: 'var(--chart-activity-accent)', stroke: 'var(--card)', strokeWidth: 2 }} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export default RequestActivityChart
