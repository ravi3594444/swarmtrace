import type React from "react"
import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import { Analytics } from "@vercel/analytics/next"
import { ClerkProvider } from "@clerk/nextjs"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toaster"
import { IntegrationsProvider } from "@/contexts/IntegrationsContext"
import { OnboardingTourProvider } from "@/components/onboarding/OnboardingTour"
import "@/lib/health-check"  // startup env-var validation (logs warnings, never throws)
import "./globals.css"


const SITE_URL = "https://swarmtrace.vercel.app"

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "SwarmTrace - Open-Source Observability for AI Agents",
    template: "%s | SwarmTrace",
  },
  description:
    "Trace, debug, and monitor AI agents and LLM swarms with 2 lines of code. Free, open-source, works with any LLM provider or framework — live cost tracking, regression detection, and token budgets included.",
  keywords: [
    "AI agent observability",
    "LLM tracing",
    "AI agent monitoring",
    "LangSmith alternative",
    "open source LLM observability",
    "LLM cost tracking",
    "AI agent debugging",
  ],
  authors: [{ name: "SwarmTrace" }],
  verification: {
    google: "rN8_3jIp7lwP69cLZpn6q9NU8a_LI3lUeKD5lPRAU1Q",
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-icon.png",
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "SwarmTrace",
    title: "SwarmTrace - Open-Source Observability for AI Agents",
    description:
      "Trace, debug, and monitor AI agents and LLM swarms with 2 lines of code. Free, open-source, works with any LLM provider or framework.",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "SwarmTrace" }],
  },
  twitter: {
    card: "summary",
    title: "SwarmTrace - Open-Source Observability for AI Agents",
    description:
      "Trace, debug, and monitor AI agents and LLM swarms with 2 lines of code. Free, open-source, works with any LLM provider or framework.",
    images: ["/icon-512.png"],
  },
}

// schema.org structured data
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "SwarmTrace",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Cross-platform",
  description:
    "Open-source observability platform for AI agents and LLM swarms. Add one decorator to any Python function to get traces, latency, token counts, and live cost — works with any LLM provider or framework.",
  url: SITE_URL,
  downloadUrl: "https://pypi.org/project/swarmtrace/",
  codeRepository: "https://github.com/ravi3594444/swarmtrace",
  license: "https://opensource.org/licenses/MIT",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <ClerkProvider
      signInFallbackRedirectUrl="/overview"
      signUpFallbackRedirectUrl="/overview"
      afterSignOutUrl="/sign-in"
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
    >
      {/* suppressHydrationWarning: next-themes sets the theme class on <html> after SSR */}
      <html
        lang="en"
        suppressHydrationWarning
        className={`${GeistSans.variable} ${GeistMono.variable}`}
      >
        <head>
          {/* schema.org structured data */}
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
          />
        </head>
        <body className="font-sans antialiased">
          {/* attribute="class" is needed: globals.css keys dark mode off the .dark class */}
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            storageKey="swarmtrace-theme"
          >
            <IntegrationsProvider>
              {/*
                Tour provider sits at the root so it survives route changes; it
                only activates on dashboard routes.
              */}
              <OnboardingTourProvider>
                {children}
              </OnboardingTourProvider>
              <Analytics />
              <Toaster />
            </IntegrationsProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}
