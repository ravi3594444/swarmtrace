'use client'

import { useState, useEffect } from 'react'
import { CheckCircle, Copy, Terminal, KeyRound, Code2, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * FirstRunEmptyState — shown on the Overview page when the user has zero
 * traces AND has never had traces before (tracked via localStorage).
 *
 * Distinguishes "brand new user who needs onboarding" from "existing user
 * who filtered to an empty time range." The former gets a rich setup guide;
 * the latter gets the existing minimal empty state.
 *
 * The 3-step checklist mirrors the actual setup flow:
 *   1. Install the SDK (pip install swarmtrace)
 *   2. Get an API key (link to /settings?tab=api)
 *   3. Decorate one function (code snippet)
 *
 * localStorage key "swarmtrace:has_traces" is set to "1" the first time
 * the dashboard sees a non-zero trace count, and never reset — so this
 * empty state shows at most once per browser. If the user clears their
 * DB, they won't see it again (which is the right behavior — they already
 * know how to set up).
 */
const STORAGE_KEY = 'swarmtrace:has_traces'

export function isFirstRun(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) !== '1'
}

export function markHasTraces() {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // localStorage may be unavailable (private mode) — non-fatal.
  }
}

const SNIPPET = `from swarmtrace import observe

@observe
def my_agent(prompt: str) -> str:
    # your agent logic here
    return "response"`

export function FirstRunEmptyState({ onWatchTour }: { onWatchTour?: () => void }) {
  const [copied, setCopied] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)

  // Check if the user already has an API key (step 2 done). We can't
  // call the API from a server component, so this is a client-side check
  // that runs after mount. If they have a key, step 2 shows a checkmark.
  useEffect(() => {
    fetch('/api/settings/api-keys')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.keys?.length > 0) setApiKey(d.keys[0].prefix + '...')
      })
      .catch(() => {})
  }, [])

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(SNIPPET)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard may be blocked — non-fatal
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 py-12 text-center">
      {/* Icon */}
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6">
        <Terminal className="w-8 h-8 text-primary" strokeWidth={1.8} />
      </div>

      {/* Headline */}
      <h2 className="text-2xl font-bold text-foreground mb-2">
        Welcome to SwarmTrace
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mb-10">
        Your dashboard is ready. Get your first trace on screen in under 60 seconds —
        three steps, no credit card.
      </p>

      {/* 3-step checklist */}
      <div className="w-full max-w-lg space-y-4 text-left">
        {/* Step 1: Install SDK */}
        <div className="flex items-start gap-4 p-4 rounded-xl border border-border bg-card">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-sm font-bold text-primary">1</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Terminal className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Install the SDK</h3>
            </div>
            <div className="flex items-center gap-2 bg-muted/60 border border-border rounded-lg px-3 py-2">
              <span className="text-xs font-mono text-muted-foreground">$</span>
              <code className="text-sm font-mono text-foreground flex-1">pip install swarmtrace</code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText('pip install swarmtrace')
                  } catch {}
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Copy install command"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-1" />
        </div>

        {/* Step 2: Get API key */}
        <div className="flex items-start gap-4 p-4 rounded-xl border border-border bg-card">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-sm font-bold text-primary">2</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <KeyRound className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Get your API key</h3>
            </div>
            {apiKey ? (
              <p className="text-xs text-muted-foreground">
                Key <code className="font-mono text-foreground">{apiKey}</code> is ready.
              </p>
            ) : (
              <Button variant="outline" size="sm" asChild className="h-7 text-xs">
                <a href="/settings?tab=api">Create a key →</a>
              </Button>
            )}
          </div>
          {apiKey && <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-1" />}
        </div>

        {/* Step 3: Decorate a function */}
        <div className="flex items-start gap-4 p-4 rounded-xl border border-border bg-card">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-sm font-bold text-primary">3</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Code2 className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Decorate one function</h3>
            </div>
            <div className="relative">
              <pre className="text-xs font-mono text-foreground bg-muted/60 border border-border rounded-lg p-3 overflow-x-auto">
                {SNIPPET}
              </pre>
              <button
                onClick={copySnippet}
                className="absolute top-2 right-2 p-1.5 rounded-md bg-card border border-border text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Copy code snippet"
              >
                {copied ? <CheckCircle className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex flex-col sm:flex-row items-center gap-3 mt-10">
        {onWatchTour && (
          <Button variant="outline" size="sm" onClick={onWatchTour}>
            Watch the tour
          </Button>
        )}
        <Button size="sm" asChild>
          <a href="https://github.com/ravi3594444/swarmtrace#readme" target="_blank" rel="noopener noreferrer">
            Full docs <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </a>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground mt-8">
        Once your agent runs, traces appear here automatically — no refresh needed.
      </p>
    </div>
  )
}
