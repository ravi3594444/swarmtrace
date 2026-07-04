import { Navigation } from '@/components/landing/navigation'
import { HeroSection } from '@/components/landing/hero-section'
import { FeaturesSection } from '@/components/landing/features-section'
import { HowItWorksSection } from '@/components/landing/how-it-works-section'
import { DevelopersSection } from '@/components/landing/developers-section'
import { PricingSection } from '@/components/landing/pricing-section'
import { FooterSection } from '@/components/landing/footer-section'

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Navigation />
      <HeroSection />
      <FeaturesSection />
      <HowItWorksSection />
      <DevelopersSection />
      <PricingSection />
      <FooterSection />
    </main>
  )
}
