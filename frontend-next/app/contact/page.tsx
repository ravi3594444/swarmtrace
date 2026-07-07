import Link from 'next/link'
import { Mail, Bug, ArrowLeft } from 'lucide-react'

export const metadata = {
  title: 'Contact — SwarmTrace',
  description: 'Get in touch with the SwarmTrace team.',
}

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-6">
      <div className="max-w-lg w-full">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to home
        </Link>
        <h1 className="text-3xl font-bold text-foreground mb-2">Contact us</h1>
        <p className="text-muted-foreground mb-8">
          Questions about Enterprise plans, support, or anything else — we&apos;d love to hear from you.
        </p>
        <div className="space-y-4">
          <a
            href="mailto:hello@swarmtrace.ai?subject=SwarmTrace%20Inquiry"
            className="flex items-center gap-4 p-5 bg-card border border-border rounded-xl hover:border-primary/50 transition-colors"
          >
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Mail className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Email</p>
              <p className="text-sm text-muted-foreground">hello@swarmtrace.ai</p>
            </div>
          </a>
          <a
            href="https://github.com/ravi3594444/swarmtrace/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-4 p-5 bg-card border border-border rounded-xl hover:border-primary/50 transition-colors"
          >
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Bug className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">GitHub Issues</p>
              <p className="text-sm text-muted-foreground">Report bugs or request features</p>
            </div>
          </a>
        </div>
      </div>
    </main>
  )
}
