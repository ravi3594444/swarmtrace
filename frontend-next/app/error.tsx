'use client'

import { useEffect, useState } from 'react'
import { Copy, Check, Home, RefreshCw } from 'lucide-react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    console.error('[swarmtrace] App error:', error)
  }, [error])

  const errorDetails = [
    `Error: ${error.message || 'An unexpected error occurred'}`,
    error.digest ? `Digest: ${error.digest}` : '',
    `Stack: ${error.stack ?? '(no stack trace)'}`,
    `URL: ${typeof window !== 'undefined' ? window.location.href : ''}`,
    `Time: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n')

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(errorDetails)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard may be blocked — non-fatal
    }
  }

  const fileIssueUrl = `https://github.com/ravi3594444/swarmtrace/issues/new?title=${encodeURIComponent(
    `Dashboard error: ${error.message?.slice(0, 80) || 'Unexpected error'}`
  )}&body=${encodeURIComponent(`\`\`\`\n${errorDetails}\n\`\`\``)}`

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center bg-background">
      {/* Error icon */}
      <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
        <span className="text-3xl">⚠️</span>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.message || 'An unexpected error occurred.'}
          {error.digest && (
            <span className="block mt-1 text-xs font-mono text-muted-foreground/60">
              Error ID: {error.digest}
            </span>
          )}
        </p>
      </div>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <button
          onClick={() => reset()}
          className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
        >
          <RefreshCw className="w-4 h-4" />
          Try again
        </button>
        <a
          href="/overview"
          className="flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-muted/60 transition-colors"
        >
          <Home className="w-4 h-4" />
          Back to dashboard
        </a>
      </div>

      {/* Developer actions */}
      <div className="flex flex-col sm:flex-row items-center gap-2 mt-2">
        <button
          onClick={copyDetails}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied!' : 'Copy error details'}
        </button>
        <span className="text-muted-foreground/30">·</span>
        <a
          href={fileIssueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
          File an issue
        </a>
      </div>
    </div>
  )
}
