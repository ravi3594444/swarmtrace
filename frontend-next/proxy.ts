import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes: the landing page, auth pages, and API routes that use
// their own auth (X-API-Key for ingest/events, Clerk for mcp via resolveApiKey).
const isPublicRoute = createRouteMatcher([
  "/",
  "/contact",
  "/privacy",
  "/terms",
  "/api/ingest(.*)",
  "/api/events(.*)",
  "/api/mcp(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Exclude static assets AND crawler files (sitemap.xml, robots.txt)
    // from the middleware. Without this exclusion, Clerk's auth.protect()
    // runs on /sitemap.xml and /robots.txt, sees no session, and returns
    // a 401/redirect — which surfaced as a 404 HTML page and prevented
    // Google from crawling the site for 2+ weeks. The matcher must also
    // exclude these explicitly because they're not under _next/static.
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
