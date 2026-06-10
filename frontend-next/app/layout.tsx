import type React from "react"
import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import { Analytics } from "@vercel/analytics/next"
import { ClerkProvider } from "@clerk/nextjs"
import { ThemeProvider } from "@/components/theme-provider"
import "./globals.css"


export const metadata: Metadata = {
  title: "SwarmTrace - AI Agent Monitoring",
  description: "Real-time observability platform for LLM swarms and AI agents",
  generator: "v0.app",
  icons: {
    icon: [
      {
        url: "/icon-light-32x32.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/icon-dark-32x32.png",
        media: "(prefers-color-scheme: dark)",
      },
      {
        url: "/icon.svg",
        type: "image/svg+xml",
      },
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
    <ClerkProvider>
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
            {children}
          </ThemeProvider>
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  )
}
