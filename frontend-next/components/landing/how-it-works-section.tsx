"use client";

import { Card } from "@/components/ui/card"
import { Code, Rocket, Activity, TrendingUp } from "lucide-react"

// Same monochrome treatment as FeaturesSection — Lucide icons (no Tabler
// CDN), tonal background, no colored icon tints.
const steps = [
  {
    title: "Instrument Your Agents",
    description: "Add our lightweight Python decorator to your agent functions. It's just 2 lines of code.",
    icon: Code,
  },
  {
    title: "Deploy Your Swarm",
    description: "Run your agents as usual. SwarmTrace automatically captures all execution data.",
    icon: Rocket,
  },
  {
    title: "Monitor in Real-time",
    description: "View traces, metrics, and logs as they happen in our intuitive dashboard.",
    icon: Activity,
  },
  {
    title: "Optimize & Scale",
    description: "Use insights to improve performance, reduce costs, and scale your swarm confidently.",
    icon: TrendingUp,
  },
]

export function HowItWorksSection() {
  return (
    <section id="how-it-works" className="py-24 bg-muted/10">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="text-center mb-16">
          <h2 className="text-4xl lg:text-5xl font-display mb-6">How It Works</h2>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            Get full observability into your AI agents with minimal setup and zero performance impact.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => {
            const Icon = step.icon
            return (
              <Card key={index} className="p-6">
                <div className="mb-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg border border-border bg-muted/60 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-foreground" aria-hidden />
                  </div>
                  <span className="text-sm font-mono text-muted-foreground">0{index + 1}</span>
                </div>
                <h3 className="text-xl font-semibold mb-3">{step.title}</h3>
                <p className="text-muted-foreground">{step.description}</p>
              </Card>
            )
          })}
        </div>
      </div>
    </section>
  )
}
