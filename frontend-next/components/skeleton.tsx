export function SkeletonMetricCard() {
  return (
    <div className="bg-surface-container border border-outline rounded-2xl p-6 animate-pulse">
      <div className="h-4 bg-surface-container-high rounded w-24 mb-4" />
      <div className="h-10 bg-surface-container-high rounded w-32 mb-2" />
      <div className="h-4 bg-surface-container-high rounded w-40" />
    </div>
  )
}

export function SkeletonTableRow() {
  return (
    <div className="space-y-2 p-6">
      <div className="h-4 bg-surface-container-high rounded w-full" />
      <div className="h-4 bg-surface-container-high rounded w-5/6" />
    </div>
  )
}

export function SkeletonChart() {
  return (
    <div className="bg-surface-container border border-outline rounded-2xl p-6 animate-pulse">
      <div className="h-6 bg-surface-container-high rounded w-40 mb-6" />
      <div className="h-72 bg-surface-container-high rounded" />
    </div>
  )
}

export function SkeletonCard() {
  return (
    <div className="bg-surface-container border border-outline rounded-2xl p-6 animate-pulse">
      <div className="h-6 bg-surface-container-high rounded w-32 mb-4" />
      <div className="space-y-3">
        <div className="h-4 bg-surface-container-high rounded w-full" />
        <div className="h-4 bg-surface-container-high rounded w-5/6" />
      </div>
    </div>
  )
}
