"use client"

import { Card } from "@/components/ui/card"

const features = [
  {
    title: "Real-time Tracing",
    description: "Capture every step of your AI agent's execution in real-time with zero overhead.",
    icon: "ti-timeline-event",
    color: "#6366f1",
  },
  {
    title: "Cost Monitoring",
    description: "Track token usage, API calls, and infrastructure costs across all your agents.",
    icon: "ti-coin",
    color: "#f59e0b",
  },
  {
    title: "Failure Detection",
    description: "Automatically detect and alert on anomalies, errors, and unexpected behavior.",
    icon: "ti-alert-triangle",
    color: "#ef4444",
  },
  {
    title: "Performance Insights",
    description: "Identify bottlenecks and optimize your agent's performance with detailed metrics.",
    icon: "ti-bolt",
    color: "#10b981",
  },
]

export function FeaturesSection() {
  return (
    <section className="py-24 bg-gradient-to-b from-background to-muted/20">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="text-center mb-16">
          <h2 className="text-4xl lg:text-5xl font-display mb-6">Powerful Features</h2>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            Everything you need to monitor, debug, and optimize your AI agents at scale.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {features.map((feature, index) => (
            <Card key={index} className="p-6 hover:shadow-lg transition-shadow">
              <div className="mb-4">
                <i
                  className={`ti ${feature.icon}`}
                  style={{ fontSize: "28px", color: feature.color }}
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-xl font-semibold mb-3">{feature.title}</h3>
              <p className="text-muted-foreground">{feature.description}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}