import type React from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowLeft, Activity, ShieldCheck, Zap } from "lucide-react"

type AuthShellProps = {
  /** Small label above the headline, e.g. "Welcome back". */
  eyebrow: string
  /** Large headline on the brand panel. */
  headline: string
  /** Supporting copy under the headline. */
  subline: string
  /** The Clerk <SignIn />/<SignUp /> widget. */
  children: React.ReactNode
}

const highlights = [
  { icon: Zap, label: "Two lines of code", detail: "Drop in a decorator and start tracing." },
  { icon: Activity, label: "Live cost + latency", detail: "Token spend per agent, per run, in real time." },
  { icon: ShieldCheck, label: "Your data, your keys", detail: "Open source, self-hostable, MIT licensed." },
]

/**
 * Shared chrome for /sign-in and /sign-up.
 *
 * Layout: a full-bleed sky photograph fills the viewport. On lg+ the screen
 * splits into a brand/marketing column and the auth card; below lg the brand
 * column collapses and only a compact wordmark + the card remain, so the form
 * is never pushed below the fold on a phone.
 *
 * The background is a real <Image> (not a CSS background) so Next can serve
 * an optimized/responsive variant and so `priority` avoids a flash of empty
 * blue on first paint of the auth route.
 */
export function AuthShell({ eyebrow, headline, subline, children }: AuthShellProps) {
  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      {/* Background photograph */}
      <Image
        src="/auth-bg.jpg"
        alt=""
        aria-hidden
        fill
        priority
        sizes="100vw"
        className="object-cover object-center -z-20"
      />

      {/*
        Readability scrim. The source image is bright at the bottom and
        saturated at the top, so plain white text fails contrast in places.
        A downward dark gradient plus a soft left-side wash keeps the brand
        copy legible without muddying the sky.
      */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-b from-sky-200/40 via-sky-100/30 to-white/70"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 lg:bg-gradient-to-r lg:from-sky-100/40 lg:via-transparent lg:to-transparent"
      />

      {/* Back to site */}
      <Link
        href="/"
        className="absolute left-5 top-5 z-20 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-sm text-white/90 backdrop-blur-md transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white lg:left-10 lg:top-8"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to site
      </Link>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1400px] flex-col items-center justify-center gap-12 px-6 py-24 lg:flex-row lg:items-center lg:justify-between lg:gap-16 lg:px-12">
        {/* Brand panel — hidden on small screens to keep the form above the fold */}
        <section className="hidden max-w-xl flex-1 text-white lg:block">
          <span className="inline-flex items-center gap-3 font-mono text-sm uppercase tracking-[0.2em] text-white/80">
            <span className="h-px w-8 bg-white/50" aria-hidden />
            {eyebrow}
          </span>

          <h1 className="mt-6 font-display text-[clamp(2.75rem,5vw,4.5rem)] leading-[0.95] tracking-tight drop-shadow-[0_2px_18px_rgba(15,23,42,0.45)]">
            {headline}
          </h1>

          <p className="mt-6 max-w-md text-lg leading-relaxed text-white/85">{subline}</p>

          <ul className="mt-10 space-y-5">
            {highlights.map(({ icon: Icon, label, detail }) => (
              <li key={label} className="flex items-start gap-4">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/25 bg-white/12 backdrop-blur-md">
                  <Icon className="size-4.5 text-white" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-medium text-white">{label}</span>
                  <span className="block text-sm text-white/70">{detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Auth card */}
        <section className="flex w-full max-w-[26rem] flex-col items-center lg:w-auto">
          {/* Compact wordmark stands in for the brand panel on mobile */}
          <div className="mb-6 text-center lg:hidden">
            <span className="font-display text-3xl font-bold text-white drop-shadow-[0_2px_14px_rgba(15,23,42,0.5)]">
              SwarmTrace
            </span>
            <p className="mt-2 text-sm text-white/80">{subline}</p>
          </div>

          <div className="w-full rounded-3xl border border-white/30 bg-white/15 p-2 shadow-[0_28px_70px_-20px_rgba(15,23,42,0.65)] backdrop-blur-2xl">
            {/*
              Always light, even under the .dark theme class: the Clerk
              appearance config is tuned for a light surface, and the sky
              photo behind it is bright in both themes. Forcing a dark card
              here would leave dark-on-dark text in the Clerk widget.
            */}
            <div className="rounded-[1.25rem] bg-white/95 p-1">{children}</div>
          </div>

          <p className="mt-6 px-2 text-center text-xs leading-relaxed text-white/75">
            By continuing you agree to our{" "}
            <Link href="/terms" className="underline underline-offset-4 hover:text-white">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline underline-offset-4 hover:text-white">
              Privacy Policy
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  )
}
