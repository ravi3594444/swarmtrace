import type { Metadata } from 'next'
import { SignIn } from '@clerk/nextjs'
import { AuthShell } from '@/components/auth/auth-shell'
import { clerkAuthAppearance } from '@/components/auth/clerk-appearance'

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your SwarmTrace dashboard to trace, debug, and monitor your AI agents.',
}

export default function Page() {
  return (
    <AuthShell
      eyebrow="Welcome back"
      headline="Every agent run, fully in view."
      subline="Sign in to pick up your traces, live cost tracking, and failure timelines exactly where you left them."
    >
      <SignIn
        appearance={clerkAuthAppearance}
        fallbackRedirectUrl="/overview"
        signUpUrl="/sign-up"
      />
    </AuthShell>
  )
}
