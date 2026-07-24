import type { Metadata } from 'next'
import { SignUp } from '@clerk/nextjs'
import { AuthShell } from '@/components/auth/auth-shell'
import { clerkAuthAppearance } from '@/components/auth/clerk-appearance'

export const metadata: Metadata = {
  title: 'Create your account',
  description: 'Create a free SwarmTrace account and start tracing your AI agents in two lines of code.',
}

export default function Page() {
  return (
    <AuthShell
      eyebrow="Get started free"
      headline="Ship agents you can actually debug."
      subline="Create an account, drop one decorator into your Python code, and watch traces, tokens, and cost land in real time."
    >
      <SignUp
        appearance={clerkAuthAppearance}
        fallbackRedirectUrl="/overview"
        signInUrl="/sign-in"
      />
    </AuthShell>
  )
}
