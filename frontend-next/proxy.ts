import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Public routes: landing page, auth pages, and API routes with their own
// auth (X-API-Key for ingest/events/mcp).
const isPublicRoute = createRouteMatcher([
  "/",
  "/contact",
  "/privacy",
  "/terms",
  "/api/ingest(.*)",
  "/api/events(.*)",
  "/api/mcp(.*)",
  // schema self-check, deliberately unauthenticated (read-only, rate-limited in the route)
  "/api/health(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

const isAuthRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  const { userId } = await auth();

  // Signed-in users who land on /sign-in or /sign-up (OAuth callback, back
  // button, bookmark) are redirected here so the sign-in form never flashes.
  if (userId && isAuthRoute(request)) {
    return NextResponse.redirect(new URL("/overview", request.url));
  }

  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // skip static assets and crawler files (sitemap.xml, robots.txt), which
    // aren't under _next/static and would otherwise hit auth.protect()
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
