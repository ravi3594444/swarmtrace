'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, LayoutGrid, Users, GitBranch, BarChart3, AlertTriangle,
  Settings2, Sun, Moon, Key, CreditCard, Puzzle, Bot,
} from 'lucide-react'
import { useTheme } from '@/components/theme-provider'

const OPEN_EVENT = 'swarmtrace:command-palette-open'

/** Open the command palette from anywhere (e.g. the header search button). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

type Item = {
  id: string
  label: string
  hint: string
  icon: React.ComponentType<{ className?: string }>
  keywords?: string
  run: () => void
}

type AgentCard = { id: string; name: string }

export function CommandPalette() {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [agents, setAgents] = useState<AgentCard[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Global shortcuts: Ctrl/Cmd+K toggles, Escape closes. Query/selection are
  // reset here (in the event handlers, not an effect) so each open starts
  // fresh without setState-in-effect.
  useEffect(() => {
    const reset = () => {
      setQuery('')
      setActiveIdx(0)
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => {
          if (!v) reset()
          return !v
        })
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    const onOpen = () => {
      reset()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  // Focus the input and fetch agents each time the palette opens.
  // Previously this was gated by fetchedRef (fetch once per session),
  // which meant new agents that started after the first open wouldn't
  // appear until a page reload. Re-fetching on every open keeps the
  // agent list fresh — the request is cheap (small payload) and the
  // palette is user-initiated so the latency is expected.
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    let cancelled = false
    fetch('/api/agents')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        if (d?.agents) {
          setAgents(
            d.agents.map((a: { id: string; name: string }) => ({
              id: a.id,
              name: a.name,
            }))
          )
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open])

  const close = () => setOpen(false)
  const go = (path: string) => {
    close()
    router.push(path)
  }

  const items: Item[] = [
    { id: 'nav-overview', label: 'Overview', hint: 'Page', icon: LayoutGrid, keywords: 'dashboard home', run: () => go('/overview') },
    { id: 'nav-agents', label: 'Agents', hint: 'Page', icon: Users, keywords: 'swarm', run: () => go('/agents') },
    { id: 'nav-traces', label: 'Traces', hint: 'Page', icon: GitBranch, keywords: 'spans waterfall', run: () => go('/traces') },
    { id: 'nav-metrics', label: 'Metrics', hint: 'Page', icon: BarChart3, keywords: 'charts stats', run: () => go('/metrics') },
    { id: 'nav-failures', label: 'Failures', hint: 'Page', icon: AlertTriangle, keywords: 'errors', run: () => go('/failures') },
    { id: 'nav-settings', label: 'Settings', hint: 'Page', icon: Settings2, keywords: 'preferences account', run: () => go('/settings') },
    { id: 'act-api-keys', label: 'API Keys', hint: 'Settings', icon: Key, keywords: 'token credentials', run: () => go('/settings?tab=api') },
    { id: 'act-billing', label: 'Billing', hint: 'Settings', icon: CreditCard, keywords: 'plan upgrade', run: () => go('/settings?tab=billing') },
    { id: 'act-integrations', label: 'Integrations', hint: 'Settings', icon: Puzzle, keywords: 'slack webhook', run: () => go('/settings?tab=integrations') },
    {
      id: 'act-theme',
      label: resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      hint: 'Action',
      icon: resolvedTheme === 'dark' ? Sun : Moon,
      keywords: 'theme dark light appearance',
      run: () => {
        setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
        close()
      },
    },
    ...agents.map((a) => ({
      id: `agent-${a.id}`,
      label: a.name,
      hint: 'Agent',
      icon: Bot,
      keywords: 'agent',
      run: () => go('/agents'),
    })),
  ]

  // Fuzzy match: for each item, compute a match score against the query.
  // The algorithm walks the query characters in order, finding each one in
  // the target string. Consecutive matches and word-boundary matches (char
  // after a space or at position 0) score higher. Items where not all query
  // chars are found in order are filtered out. This lets users type "ov"
  // to match "Overview", "st" to match "Settings", etc. — much more
  // forgiving than the old strict substring filter.
  const q = query.trim().toLowerCase()
  const filtered: Item[] = q
    ? items
        .map((i) => {
          const target = `${i.label} ${i.keywords ?? ''} ${i.hint}`.toLowerCase()
          let score = 0
          let qi = 0
          let consecutive = 0
          for (let ti = 0; ti < target.length && qi < q.length; ti++) {
            if (target[ti] === q[qi]) {
              const isBoundary = ti === 0 || target[ti - 1] === ' '
              score += isBoundary ? 3 : 1
              consecutive += 1
              score += consecutive
              qi += 1
            } else {
              consecutive = 0
            }
          }
          return qi === q.length ? { item: i, score } : null
        })
        .filter((x): x is { item: Item; score: number } => x !== null)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.item)
    : items
  const active = Math.min(activeIdx, Math.max(filtered.length - 1, 0))

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] flex items-start justify-center pt-[15vh] px-4 animate-backdrop-fade-in"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-lg bg-card border border-border rounded-xl overflow-hidden animate-palette-pop-in transition-[background-color,border-color,color] duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx((i) => Math.min(i + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                filtered[active]?.run()
              }
            }}
            placeholder="Search pages, agents, actions…"
            className="flex-1 py-3.5 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
          <kbd className="text-[11px] text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0">Esc</kbd>
        </div>
        <div className="max-h-72 overflow-y-auto py-2" role="listbox">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">No results for &ldquo;{query}&rdquo;</p>
          ) : (
            filtered.map((item, idx) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  role="option"
                  aria-selected={idx === active}
                  onClick={item.run}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                    idx === active ? 'bg-muted/60 text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground/60 shrink-0">{item.hint}</span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
