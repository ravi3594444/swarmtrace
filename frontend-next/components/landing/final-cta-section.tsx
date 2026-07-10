"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"

/**
 * Final CTA — replaces the old pricing section on the landing page.
 *
 * The pricing/subscription section was removed because paid plans aren't
 * live yet (see the "Coming Soon" badge on the billing tab in settings).
 * Showing prices that users can't actually pay would be misleading. This
 * CTA keeps the conversion path (sign up + GitHub) without promising
 * paid tiers that don't exist yet. When Stripe billing ships, a pricing
 * section can return here.
 */
export function FinalCtaSection() {
  return (
    <section id="get-started" className="py-32 relative overflow-hidden">
      {/* Subtle gradient backdrop */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-foreground/[0.02] to-transparent pointer-events-none" />

      <div className="relative max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="max-w-3xl mx-auto text-center">
          {/* Eyebrow */}
          <div className="mb-6">
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground">
              <span className="w-8 h-px bg-foreground/30" />
              Free during beta
              <span className="w-8 h-px bg-foreground/30" />
            </span>
          </div>

          {/* Headline */}
          <h2 className="text-4xl lg:text-6xl font-display leading-tight tracking-tight mb-6">
            Ready to debug
            <br />
            <span className="text-muted-foreground">your AI agents?</span>
          </h2>

          {/* Subhead */}
          <p className="text-lg lg:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            Install the SDK, decorate one function, and see every trace on the
            dashboard in under 60 seconds. No credit card, no sales call.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button
              size="lg"
              className="bg-foreground hover:bg-foreground/90 text-background px-8 h-14 text-base rounded-full w-full sm:w-auto"
              asChild
            >
              <Link href="/sign-up">Get Started Free</Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-14 px-8 text-base rounded-full border-foreground/20 hover:bg-foreground/5 w-full sm:w-auto"
              asChild
            >
              <a
                href="https://github.com/ravi3594444/swarmtrace"
                target="_blank"
                rel="noopener noreferrer"
              >
                View on GitHub
              </a>
            </Button>
          </div>

          {/* Install snippet */}
          <div className="mt-10 inline-flex items-center gap-3 bg-muted/60 border border-border rounded-full px-5 py-2.5">
            <span className="text-xs font-mono text-muted-foreground">$</span>
            <code className="text-sm font-mono text-foreground">pip install swarmtrace</code>
          </div>
        </div>
      </div>
    </section>
  )
}
