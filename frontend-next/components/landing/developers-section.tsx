"use client"

import { Button } from "@/components/ui/button"

export function DevelopersSection() {
  return (
    <section id="developers" className="py-24 bg-gradient-to-b from-muted/10 to-background">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <h2 className="text-4xl lg:text-5xl font-display mb-6">Built for Developers</h2>
            <p className="text-xl text-muted-foreground mb-8 leading-relaxed">
              SwarmTrace is designed by developers, for developers. We focus on providing the
              tools and insights you need without getting in your way.
            </p>

            <div className="space-y-4 mb-8">
              {[
                { text: "Open-source instrumentation", icon: "ti-brand-github" },
                { text: "API-first design",             icon: "ti-api"          },
                { text: "CLI tools for local development", icon: "ti-terminal"  },
                { text: "Webhook integrations",         icon: "ti-webhook"      },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <i className={`ti ${item.icon}`} style={{ fontSize: "18px", color: "#6366f1" }} aria-hidden="true" />
                  <span>{item.text}</span>
                </div>
              ))}
            </div>

            <Button size="lg" asChild>
              <a href="https://github.com/ravi3594444/swarmtrace" target="_blank" rel="noopener noreferrer">
                View on GitHub
              </a>
            </Button>
          </div>

          <div className="bg-muted/20 rounded-lg p-8 border border-border/20">
            <div className="font-mono text-sm space-y-4">
              <div className="text-muted-foreground"># Instrument your agent</div>
              <div className="text-green-400">from swarmtrace import trace_agent</div>
              <div className="text-green-400"></div>
              <div className="text-muted-foreground">@trace_agent</div>
              <div className="text-blue-400">def</div> <div className="text-yellow-300">your_agent_function</div>(<div className="text-orange-400">context</div>):
              <div className="ml-4 text-muted-foreground"># Your agent logic here</div>
              <div className="ml-4 text-blue-400">return</div> <div className="text-green-300">result</div>

              <div className="text-muted-foreground pt-4"># That's it! 🎉</div>
              <div className="text-muted-foreground"># All traces are automatically captured</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}