/**
 * Shared Recharts tooltip style for the SwarmTrace dashboard.
 *
 * Previously duplicated in app/overview/page.tsx and app/metrics/page.tsx
 * as identical object literals. Extracted so both pages (and any future
 * chart page) stay visually consistent. The `cursor` prop is included
 * even though metrics didn't have it — Recharts ignores extra props, and
 * having the dashed cursor on hover improves chart readability.
 */
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
