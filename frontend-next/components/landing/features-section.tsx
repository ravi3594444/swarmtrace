"use client";

import { Card } from "@/components/ui/card"
import { Activity, DollarSign, AlertTriangle, Zap } from "lucide-react"

// Landing page now uses the same monochrome palette as the dashboard —
// no indigo/amber/red/emerald. Feature identity comes from the Lucide icon
// (Lucide is already bundled; the old Tabler CDN <link> is removed from
// layout.tsx), with a tonal background tint that follows the app's
// surface tokens. The dashboard is strictly achromatic per DESIGN.md, so
// the landing page no longer feels like a different product.
const features = [
  {
    title: "Real-time Tracing",
    description: "Capture every step of your AI agent's execution in real-time with zero overhead.",
    icon: Activity,
  },
  {
    title: "Cost Monitoring",
    description: "Track token usage, API calls, and infrastructure costs across all your agents.",
    icon: DollarSign,
  },
  {
    title: "Failure Detection",
    description: "Automatically detect and alert on anomalies, errors, and unexpected behavior.",
    icon: AlertTriangle,
  },
  {
    title: "Performance Insights",
    description: "Identify bottlenecks and optimize your agent's performance with detailed metrics.",
    icon: Zap,
  },
]

export function FeaturesSection() {
  return (
    <section id="features" className="py-24 bg-gradient-to-b from-background to-muted/20">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="text-center mb-16">
          <h2 className="text-4xl lg:text-5xl font-display mb-6">Powerful Features</h2>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            Everything you need to monitor, debug, and optimize your AI agents at scale.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon
            return (
              <Card key={index} interactive className="p-6">
                <div className="mb-4">
                  <div className="w-12 h-12 rounded-xl border border-border bg-muted/60 flex items-center justify-center">
                    <Icon className="w-6 h-6 text-foreground" aria-hidden />
                  </div>
                </div>
                <h3 className="text-xl font-semibold mb-3">{feature.title}</h3>
                <p className="text-muted-foreground">{feature.description}</p>
              </Card>
            )
          })}
        </div>
      </div>
    </section>
  )
}
