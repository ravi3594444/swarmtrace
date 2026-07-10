'use client'

import { useEffect, useState } from 'react'
import { Star, Download } from 'lucide-react'

/**
 * SocialProofBadges — fetches GitHub stars + PyPI download count on mount
 * and renders them as small badges. Gives new visitors immediate trust
 * signals.
 *
 * Client-side fetch (the hero is a client component, so this can't be a
 * server component). The APIs are public, no auth needed. If either fetch
 * fails, the badge is omitted rather than showing "0".
 */
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function SocialProofBadges() {
  const [stars, setStars] = useState<number | null>(null)
  const [downloads, setDownloads] = useState<number | null>(null)

  useEffect(() => {
    fetch('https://api.github.com/repos/ravi3594444/swarmtrace')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.stargazers_count != null) setStars(d.stargazers_count) })
      .catch(() => {})

    fetch('https://pypistats.org/api/packages/swarmtrace/recent')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.data?.downloads != null) setDownloads(d.data.downloads) })
      .catch(() => {})
  }, [])

  if (stars === null && downloads === null) return null

  return (
    <div className="flex items-center gap-3 mb-8">
      {stars !== null && stars > 0 && (
        <a
          href="https://github.com/ravi3594444/swarmtrace"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border/50 bg-background/50 backdrop-blur-sm text-xs font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <Star className="w-3 h-3 fill-foreground/80 text-foreground/80" />
          <span className="font-bold text-foreground">{formatNumber(stars)}</span>
          <span>stars</span>
        </a>
      )}
      {downloads !== null && downloads > 0 && (
        <a
          href="https://pypi.org/project/swarmtrace/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border/50 bg-background/50 backdrop-blur-sm text-xs font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <Download className="w-3 h-3 text-foreground/80" />
          <span className="font-bold text-foreground">{formatNumber(downloads)}</span>
          <span>downloads</span>
        </a>
      )}
    </div>
  )
}
