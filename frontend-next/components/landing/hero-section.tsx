"use client";
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

import { AnimatedSphere } from "./animated-sphere";

const words = ["trace", "debug", "monitor", "fix"];

export function HeroSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => { setIsVisible(true); }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % words.length);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="relative min-h-screen flex flex-col overflow-hidden">

      {/* Animated sphere — right side */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2 w-[600px] h-[600px] lg:w-[800px] lg:h-[800px] opacity-40 pointer-events-none">
        <AnimatedSphere />
      </div>

      {/* Grid lines */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-30">
        {[...Array(8)].map((_, i) => (
          <div key={`h-${i}`} className="absolute h-px bg-foreground/10"
            style={{ top: `${12.5 * (i + 1)}%`, left: 0, right: 0 }} />
        ))}
        {[...Array(12)].map((_, i) => (
          <div key={`v-${i}`} className="absolute w-px bg-foreground/10"
            style={{ left: `${8.33 * (i + 1)}%`, top: 0, bottom: 0 }} />
        ))}
      </div>

      {/* Headline — top left */}
      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12 pt-40 w-full">

        {/* Eyebrow */}
        <div className={`mb-8 transition-all duration-700 ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        }`}>
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground">
            <span className="w-8 h-px bg-foreground/30" />
            Now on PyPI — pip install swarmtrace
          </span>
        </div>

        {/* Big headline */}
        <h1 className={`text-[clamp(3rem,12vw,10rem)] font-display leading-[0.9] tracking-tight transition-all duration-1000 ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
        }`}>
          <span className="block">The platform</span>
          <span className="block">
            to{" "}
            <span className="relative inline-block">
              <span key={wordIndex} className="inline-flex">
                {words[wordIndex].split("").map((char, i) => (
                  <span
                    key={`${wordIndex}-${i}`}
                    className="inline-block animate-char-in"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    {char}
                  </span>
                ))}
              </span>
              <span className="absolute -bottom-2 left-0 right-0 h-3 bg-foreground/10" />
            </span>
          </span>
          <span className="block">your AI agents</span>
        </h1>
      </div>

      {/* Buttons — bottom right */}
      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12 pb-32 w-full mt-auto">
        <div className={`flex flex-row items-center justify-end gap-4 transition-all duration-700 delay-300 ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        }`}>
          <Button
            size="lg"
            className="bg-foreground hover:bg-foreground/90 text-background px-8 h-14 text-base rounded-full"
            asChild
          >
            <a href="/sign-up">Get Started Free</a>
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="h-14 px-8 text-base rounded-full border-foreground/20 hover:bg-foreground/5"
            asChild
          >
            <a href="https://github.com/ravi3594444/swarmtrace">
              View on GitHub
            </a>
          </Button>
        </div>
      </div>

      {/* Stats marquee — very bottom */}
      <div className={`absolute bottom-8 left-0 right-0 overflow-hidden transition-all duration-700 delay-500 ${
        isVisible ? "opacity-100" : "opacity-0"
      }`}>
        <div className="flex gap-24 marquee whitespace-nowrap">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex gap-24 shrink-0">
              {[
                { value: "< 1s",    label: "Trace ingestion latency", note: "REAL-TIME"   },
                { value: "2 lines", label: "To full observability",    note: "PIP INSTALL" },
                { value: "0ms",     label: "Overhead on your agent",   note: "@OBSERVE"    },
                { value: "100%",    label: "Automatic trace coverage", note: "AUTOMATIC"   },
              ].map((s) => (
                <div key={`${s.note}-${i}`} className="flex flex-col justify-start">
                  <span className="text-4xl lg:text-5xl font-display leading-none mb-1">{s.value}</span>
                  <span className="text-sm text-muted-foreground leading-tight">{s.label}</span>
                  <span className="text-[10px] font-mono text-muted-foreground/40 tracking-widest mt-1">{s.note}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

    </section>
  );
}
