import type React from "react"
import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import { Analytics } from "@vercel/analytics/next"
import { ClerkProvider } from "@clerk/nextjs"
import { ThemeProvider } from "@/components/theme-provider"
import { IntegrationsProvider } from "@/contexts/IntegrationsContext"
import "./globals.css"


export const metadata: Metadata = {
  title: "SwarmTrace - AI Agent Monitoring",
  description: "Real-time observability platform for LLM swarms and AI agents",
  verification: {
    google: "FKuXzQR0mShmnAc_vV98diBhBW7OlVRes_lnm2HbbgM",
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-icon.png",
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
      {/*
        suppressHydrationWarning is required here:
        next-themes writes the theme class (e.g. "dark") to <html> on the client
        after SSR, which causes a React hydration mismatch without this flag.
      */}
      <html
        lang="en"
        suppressHydrationWarning
        className={`${GeistSans.variable} ${GeistMono.variable}`}
      >
        <head>
          {/* Loaded as <link> instead of CSS @import to avoid PostCSS ordering
              violations (inlined @imports from tw-animate-css would precede it)
              and because <link> loads in parallel while @import is render-blocking. */}
          <link
            rel="stylesheet"
            href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.31.0/dist/tabler-icons.min.css"
          />
        </head>
        <body className="font-sans antialiased">
          {/*
            attribute="class" is REQUIRED — without it next-themes defaults to
            data-theme="dark" on <html>, but globals.css uses
            @custom-variant dark (&:is(.dark *)) which needs the .dark CLASS.
            Omitting this breaks all dark-mode CSS variables and the sphere color.
          */}
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            storageKey="swarmtrace-theme"
          >
            <IntegrationsProvider>
              {children}
              <Analytics />
            </IntegrationsProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}
