import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export const metadata = {
  title: 'Privacy Policy — SwarmTrace',
  description: 'How SwarmTrace collects, uses, and protects your data.',
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to home
        </Link>
        <h1 className="text-3xl font-bold text-foreground mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: July 2026</p>
        <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Data we collect</h2>
            <p>
              SwarmTrace stores the account details you provide at sign-up (name and email, managed
              via Clerk) and the trace data your instrumented agents send to our API: span metadata,
              latency, token counts, cost estimates, and error messages.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">How we use it</h2>
            <p>
              Trace data is used solely to power your dashboard — metrics, failure analysis, and cost
              projections. We do not sell your data or share it with third parties.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Retention</h2>
            <p>
              Trace data is retained according to your plan (7 days on Hobby, 90 days on Pro). You can
              delete your account and all associated data at any time from Settings.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Contact</h2>
            <p>
              Questions about this policy? <Link href="/contact" className="text-primary hover:underline">Contact us</Link>.
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
