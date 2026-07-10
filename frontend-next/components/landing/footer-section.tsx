"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"

export function FooterSection() {
  const currentYear = new Date().getFullYear()

  return (
    <footer className="border-t border-border/20 py-16">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12 mb-12">
          <div>
            <h3 className="font-semibold mb-4">Product</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/#features" className="hover:text-foreground transition-colors">Features</Link></li>
              <li><Link href="/#how-it-works" className="hover:text-foreground transition-colors">How it works</Link></li>
              <li><Link href="/#get-started" className="hover:text-foreground transition-colors">Get Started</Link></li>
              <li><a href="https://github.com/ravi3594444/swarmtrace#readme" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Documentation</a></li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Company</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/#developers" className="hover:text-foreground transition-colors">About</Link></li>
              <li><Link href="/contact" className="hover:text-foreground transition-colors">Contact</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Resources</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><a href="https://github.com/ravi3594444/swarmtrace" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">GitHub</a></li>
              <li><a href="https://pypi.org/project/swarmtrace/" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">PyPI</a></li>
              <li><a href="https://github.com/ravi3594444/swarmtrace/discussions" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Community</a></li>
              <li><Link href="/contact" className="hover:text-foreground transition-colors">Support</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Legal</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link></li>
              <li><Link href="/terms" className="hover:text-foreground transition-colors">Terms</Link></li>
              <li><a href="https://github.com/ravi3594444/swarmtrace/security" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Security</a></li>
            </ul>
          </div>
        </div>

        <div className="flex flex-col md:flex-row justify-between items-center pt-8 border-t border-border/20">
          <div className="flex items-center gap-2 mb-4 md:mb-0">
            <span className="font-display text-lg font-bold">SwarmTrace</span>
          </div>

          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" asChild>
              <a href="https://github.com/ravi3594444/swarmtrace" target="_blank" rel="noopener noreferrer">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                  <path d="M9 18c-4.51 2-5-2-7-2" />
                </svg>
              </a>
            </Button>
          </div>

          <p className="text-sm text-muted-foreground mt-4 md:mt-0">
            © {currentYear} SwarmTrace. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}