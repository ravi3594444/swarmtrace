import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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
  // Schema self-check — no auth on purpose (works pre-sign-in, which is
  // exactly when operators need it). Read-only, rate-limited in the route.
  "/api/health(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

const isAuthRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  const { userId } = await auth();

  // Already signed in but the request landed on /sign-in or /sign-up
  // anyway (post-OAuth callback, back button, a stale bookmark). Send
  // straight to the dashboard here, at the proxy layer, so the redirect
  // happens before any HTML ships — otherwise the sign-in form paints
  // first and only jumps to /overview once Clerk's client JS catches up,
  // which is the "splash" flash.
  if (userId && isAuthRoute(request)) {
    return NextResponse.redirect(new URL("/overview", request.url));
  }

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
