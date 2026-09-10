'use client'

import { useState, useEffect } from 'react'
import { CheckCircle, Copy, Terminal, KeyRound, Code2, ArrowRight, Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOnboardingTour } from '@/components/onboarding/OnboardingTour'

/**
 * FirstRunEmptyState — shown on Overview and Home when the user has zero
 * traces AND has never had traces before (tracked via localStorage).
 *
 * Distinguishes "brand new user who needs onboarding" from "existing user
 * who filtered to an empty time range." The former gets a rich setup guide;
 * the latter gets the existing minimal empty state.
 *
 * The three steps are the whole path from nothing to a first trace on
 * screen, in the order the SDK expects them:
 *   1. Install the SDK (pip install swarmtrace)
 *   2. Point it at this dashboard (API key + endpoint env vars)
 *   3. Decorate a function and call it — that call IS the first trace
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

const INSTALL_CMD = 'pip install swarmtrace'

const ENV_SNIPPET = `export SWARMTRACE_API_KEY=your-key
export SWARMTRACE_ENDPOINT=https://swarmtrace.vercel.app`

const SNIPPET = `from swarmtrace import observe

@observe
def my_agent(question):
    return llm.chat(question)

# This call is your first trace.
my_agent("What is machine learning?")`

/** Copy-to-clipboard button that confirms itself for two seconds. */
function CopyButton({
  value, label, className = '',
}: {
  value: string
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard may be blocked — non-fatal
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={`text-muted-foreground hover:text-foreground transition-colors ${className}`}
    >
      {copied
        ? <CheckCircle className="w-3.5 h-3.5 text-green-500" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

/** One numbered step of the setup guide. */
function Step({
  n, icon: Icon, title, hint, done, children,
}: {
  n: number
  icon: typeof Terminal
  title: string
  hint?: string
  done?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-xl border border-border bg-card">
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <span className="text-sm font-bold text-primary">{n}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        {hint && <p className="mb-2 text-xs text-muted-foreground">{hint}</p>}
        {children}
      </div>
      {done && <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-1" />}
    </div>
  )
}

export function FirstRunEmptyState() {
  const [apiKey, setApiKey] = useState<string | null>(null)
  const { startTour } = useOnboardingTour()

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
        Nothing has been traced yet. Here is how to send your first trace — three
        steps, about a minute, no credit card.
      </p>

      {/* 3-step guide */}
      <div className="w-full max-w-lg space-y-4 text-left">
        {/* Step 1: Install SDK
            No checkmark here — we can't reliably detect from the browser
            whether pip install actually ran, so showing a green check
            would be misleading. Only step 2 (API key) gets a checkmark
            because we can verify it via the /api/settings/api-keys call. */}
        <Step n={1} icon={Terminal} title="Install the SDK" hint="In the environment your agent runs in.">
          <div className="flex items-center gap-2 bg-muted/60 border border-border rounded-lg px-3 py-2">
            <span className="text-xs font-mono text-muted-foreground">$</span>
            <code className="text-sm font-mono text-foreground flex-1">{INSTALL_CMD}</code>
            <CopyButton value={INSTALL_CMD} label="Copy install command" />
          </div>
        </Step>

        {/* Step 2: Point the SDK at this dashboard */}
        <Step
          n={2}
          icon={KeyRound}
          title="Point it at this dashboard"
          hint="The SDK reads these two variables to know where to send traces."
          done={!!apiKey}
        >
          <div className="relative">
            <pre className="text-xs font-mono text-foreground bg-muted/60 border border-border rounded-lg p-3 pr-10 overflow-x-auto">
              {ENV_SNIPPET}
            </pre>
            <CopyButton
              value={ENV_SNIPPET}
              label="Copy environment variables"
              className="absolute top-2 right-2 p-1.5 rounded-md bg-card border border-border"
            />
          </div>
          {apiKey ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Use your key <code className="font-mono text-foreground">{apiKey}</code> in place of{' '}
              <code className="font-mono text-foreground">your-key</code>.
            </p>
          ) : (
            <Button variant="outline" size="sm" asChild className="h-7 text-xs mt-2">
              <a href="/settings?tab=api">Create a key →</a>
            </Button>
          )}
        </Step>

        {/* Step 3: Decorate a function and run it */}
        <Step
          n={3}
          icon={Code2}
          title="Trace a function and run it"
          hint="@observe records the call — latency, tokens, cost, errors and all."
        >
          <div className="relative">
            <pre className="text-xs font-mono text-foreground bg-muted/60 border border-border rounded-lg p-3 pr-10 overflow-x-auto">
              {SNIPPET}
            </pre>
            <CopyButton
              value={SNIPPET}
              label="Copy code snippet"
              className="absolute top-2 right-2 p-1.5 rounded-md bg-card border border-border"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Run that script once. Every nested LLM and tool call inside{' '}
            <code className="font-mono text-foreground">my_agent</code> is captured too.
          </p>
        </Step>
      </div>

      {/* Footer actions */}
      <div className="flex flex-col sm:flex-row items-center gap-3 mt-10">
        <Button size="sm" onClick={startTour}>
          <Compass className="w-3.5 h-3.5 mr-1" />
          Take the tour <ArrowRight className="w-3.5 h-3.5 ml-1" />
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href="https://github.com/ravi3594444/swarmtrace#readme" target="_blank" rel="noopener noreferrer">
            Full docs
          </a>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground mt-8">
        The moment that call runs, its trace appears here — this page updates on its
        own, no refresh needed.
      </p>
    </div>
  )
}
