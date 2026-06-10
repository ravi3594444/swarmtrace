"use client"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export function PricingSection() {
  const plans = [
    {
      name: "Free",
      price: "$0",
      description: "Perfect for small projects and getting started",
      features: [
        "Up to 1,000 traces/month",
        "Basic metrics & dashboards",
        "Community support",
        "1 team member"
      ],
      cta: "Get Started"
    },
    {
      name: "Pro",
      price: "$49",
      description: "For growing teams and production workloads",
      features: [
        "Up to 50,000 traces/month",
        "Advanced analytics",
        "Priority support",
        "5 team members",
        "Custom dashboards"
      ],
      cta: "Start Free Trial",
      featured: true
    },
    {
      name: "Enterprise",
      price: "Custom",
      description: "For large-scale deployments and mission-critical applications",
      features: [
        "Unlimited traces",
        "Dedicated support",
        "SSO & SAML",
        "Custom integrations",
        "On-premise options"
      ],
      cta: "Contact Sales"
    }
  ]

  return (
    <section className="py-24">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="text-center mb-16">
          <h2 className="text-4xl lg:text-5xl font-display mb-6">Simple, Transparent Pricing</h2>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            No hidden fees. No surprises. Just powerful observability for your AI agents.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, index) => (
            <Card
              key={index}
              className={`p-8 ${plan.featured ? 'border-primary/50 ring-2 ring-primary' : ''}`}
            >
              <h3 className="text-2xl font-semibold mb-2">{plan.name}</h3>
              <p className="text-muted-foreground mb-6">{plan.description}</p>

              <div className="mb-8">
                <span className="text-4xl font-bold">{plan.price}</span>
                {plan.price !== "Custom" && <span className="text-muted-foreground">/month</span>}
              </div>

              <ul className="space-y-3 mb-8">
                {plan.features.map((feature, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <span className="text-green-500">✓</span>
                    <span className="text-sm">{feature}</span>
                  </li>
                ))}
              </ul>

              <Button
                className="w-full"
                variant={plan.featured ? "default" : "outline"}
                asChild
              >
                <a href={plan.name === "Enterprise" ? "/contact" : "/sign-up"}>
                  {plan.cta}
                </a>
              </Button>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}