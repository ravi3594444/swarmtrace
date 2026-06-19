import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import loadingAnimation from "../assets/loading.lottie";

interface LoadingScreenProps {
  message?: string;
}

export function LoadingScreen({ message = "Loading..." }: LoadingScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[320px] py-12 gap-4 fade-slide-in">
      <DotLottieReact
        src={loadingAnimation}
        autoplay
        loop
        style={{ width: 140, height: 140 }}
      />
      <p className="text-sm text-muted-foreground font-mono tracking-wider uppercase">
        {message}
      </p>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-3">
      <div className="h-3 w-24 rounded skeleton-shimmer" />
      <div className="h-8 w-32 rounded skeleton-shimmer" />
      <div className="h-3 w-40 rounded skeleton-shimmer" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <tr>
      {[...Array(6)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-3 rounded skeleton-shimmer" style={{ width: `${60 + Math.random() * 40}%` }} />
        </td>
      ))}
    </tr>
  );
}
