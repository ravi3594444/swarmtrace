import type { MetadataRoute } from 'next'

// Use NEXT_PUBLIC_APP_URL when deployed; fall back to the Vercel URL.
const BASE = (process.env.NEXT_PUBLIC_APP_URL || 'https://swarmtrace.vercel.app').replace(/\/$/, '')

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: BASE,              lastModified: new Date(), changeFrequency: 'weekly',  priority: 1   },
    { url: `${BASE}/sign-in`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE}/sign-up`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
  ]
}
