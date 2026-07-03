import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes: the landing page, auth pages, and API routes that use
// their own auth (X-API-Key for ingest/events, Clerk for mcp via resolveApiKey).
const isPublicRoute = createRouteMatcher([
  "/",
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
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
