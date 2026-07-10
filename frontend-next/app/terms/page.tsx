import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export const metadata = {
  title: 'Terms of Service — SwarmTrace',
  description: 'Terms governing your use of SwarmTrace.',
}

export default function TermsPage() {
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
        <h1 className="text-3xl font-bold text-foreground mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: July 2026</p>
        <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Use of the service</h2>
            <p>
              SwarmTrace provides observability tooling for AI agent systems. You may use the service
              to monitor agents you own or are authorized to monitor. You are responsible for the
              content of the traces you send.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Plans and limits</h2>
            <p>
              Free (Hobby) accounts are limited to 10,000 traces per month with 7-day retention.
              Requests beyond your plan limits may be rejected. Paid plans are coming soon —
              see the <Link href="/settings?tab=billing" className="text-primary hover:underline"> billing section</Link> in
              your dashboard for details.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Availability and liability</h2>
            <p>
              The service is provided &quot;as is&quot; without warranty of any kind. We are not liable for
              indirect or consequential damages arising from use of the service.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">Contact</h2>
            <p>
              Questions about these terms? <Link href="/contact" className="text-primary hover:underline">Contact us</Link>.
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
