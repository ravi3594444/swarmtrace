import type React from "react"
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Playfair_Display, IBM_Plex_Mono } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { ClerkProvider } from "@clerk/nextjs"
import { ThemeProvider } from "@/components/theme-provider"
import "./globals.css"

const _geist = Geist({ subsets: ["latin"], variable: "--font-geist" })
const _geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

// --font-instrument-serif is referenced in globals.css as the value of --font-display
// DO NOT rename this to --font-display — that would create a circular CSS var reference
const _playfairDisplay = Playfair_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument",
})
const _playfairSerif = Playfair_Display({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-instrument-serif",
})
// --font-jetbrains is referenced in globals.css as the value of --font-mono
// DO NOT rename to --font-mono-display — same circular ref risk
const _ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-jetbrains",
})

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
        className={`${_playfairDisplay.variable} ${_playfairSerif.variable} ${_ibmPlexMono.variable} ${_geist.variable} ${_geistMono.variable}`}
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
