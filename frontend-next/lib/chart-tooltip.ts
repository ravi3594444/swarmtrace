/** Shared Recharts tooltip style for the overview and metrics pages. */
export const chartTooltip = {
  contentStyle: {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    fontSize: 12,
    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
  },
  labelStyle: { color: 'var(--foreground)', fontWeight: 600 },
  itemStyle: { color: 'var(--foreground)' },
  cursor: { stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '4 4' },
} as const
