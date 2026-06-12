/** @type {import('next').NextConfig} */
const nextConfig = {
  // TypeScript errors now fail the build — no silent surprises in production.
  // Fix any TS errors reported by `next build` before deploying.
  images: {
    unoptimized: true,
  },
}

export default nextConfig
