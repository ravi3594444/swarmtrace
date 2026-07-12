/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options',        value: 'DENY' },
          { key: 'X-Content-Type-Options',  value: 'nosniff' },
          { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',      value: 'camera=(), microphone=(), geolocation=()' },
          {
            key:   'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            // Tighten this once the Clerk/Supabase/CDN hostnames are stable.
            // For now: block framing everywhere except Clerk's CAPTCHA
            // (Cloudflare Turnstile), disallow plugins, allow only HTTPS
            // resources. Inline styles/scripts are needed by Clerk and
            // Next.js so 'unsafe-inline' stays for now.
            //
            // CAPTCHA NOTE: Clerk uses Cloudflare Turnstile for bot protection
            // on sign-up/sign-in. Turnstile loads in an iframe from
            // https://challenges.cloudflare.com and needs:
            //   - frame-src https://challenges.cloudflare.com (the iframe)
            //   - script-src https://challenges.cloudflare.com (the loader)
            //   - connect-src https://challenges.cloudflare.com (token verify)
            // Without all three, the CAPTCHA widget doesn't render and
            // sign-up is completely blocked (reproduced in production —
            // CSP violation in console, no widget appears).
            key:   'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://clerk.swarmtrace.ai https://*.clerk.accounts.dev https://challenges.cloudflare.com",
              "worker-src 'self' blob:",
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
              "font-src 'self' https://cdn.jsdelivr.net",
              "img-src 'self' data: blob: https:",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com",
              "frame-src https://challenges.cloudflare.com",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

export default nextConfig
