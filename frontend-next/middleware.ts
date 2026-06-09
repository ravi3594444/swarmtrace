import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes that bypass Clerk authentication
// We must keep /api/ingest public so your Python agent tracers can POST trace telemetry
const isPublicRoute = createRouteMatcher([
  "/api/ingest(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)"
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static assets
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
