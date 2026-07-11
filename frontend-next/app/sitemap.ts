import type { MetadataRoute } from 'next'

// Use NEXT_PUBLIC_APP_URL when deployed; fall back to the Vercel URL.
const BASE = (process.env.NEXT_PUBLIC_APP_URL || 'https://swarmtrace.vercel.app').replace(/\/$/, '')

export default function sitemap(): MetadataRoute.Sitemap {
  // Only list public, indexable content pages.
  // /sign-in and /sign-up are intentionally excluded — they're not search
  // targets (nobody searches "swarmtrace sign in" before knowing the product)
  // and indexing them would dilute the ranking signal for the pages that
  // actually matter. Dashboard routes (/overview, /traces, /agents, /metrics,
  // /settings) are disallowed in robots.txt because they require auth.
  return [
    { url: BASE,             lastModified: new Date(), changeFrequency: 'weekly',  priority: 1   },
    { url: `${BASE}/contact`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE}/privacy`, lastModified: new Date(), changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${BASE}/terms`,   lastModified: new Date(), changeFrequency: 'yearly',  priority: 0.3 },
  ]
}
