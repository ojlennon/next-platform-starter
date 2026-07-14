import { NextResponse } from 'next/server';
import { withCheckpoint } from '@kya-os/checkpoint-nextjs';

/**
 * Checkpoint middleware enforcement, merged with this app's existing
 * request-handling logic (previously in `middleware.js`).
 *
 * Uses the Next.js 16 `proxy` file convention, which runs on the Node.js
 * runtime — the correct home for `withCheckpoint`, whose default package
 * export is the Node build of the in-process WASM engine (no Edge runtime).
 *
 * Configuration comes from environment variables — see `.env.local` /
 * `.env.example`. `tenantHost` is required; `apiKey` is optional and enables
 * detections to report to the Checkpoint dashboard.
 */
const checkpoint = withCheckpoint({
  // Required. TODO: set CHECKPOINT_TENANT_HOST to your dashboard/tenant hostname.
  tenantHost: process.env.CHECKPOINT_TENANT_HOST ?? 'your.tenant.example',
  // Optional — enables dashboard reporting.
  apiKey: process.env.CHECKPOINT_API_KEY,
  // Optional — enables in-process enforcement of your composed Cedar policy.
  // projectId: process.env.CHECKPOINT_PROJECT_ID,
});

/**
 * Copy Checkpoint's verdict headers (`X-Checkpoint-*`) and its verdict cookie
 * from a pass-through response onto a new terminal response (e.g. a redirect),
 * so the engine's contract is preserved no matter which branch we return from.
 */
function carryCheckpointVerdict(from, to) {
  from.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-checkpoint')) {
      to.headers.set(key, value);
    }
  });
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
}

export async function proxy(request, event) {
  // 1. Run Checkpoint enforcement first, before any app logic.
  const checkpointResponse = await checkpoint(request, event);

  // 2. If Checkpoint did NOT pass the request through — i.e. it blocked,
  //    redirected, or issued a challenge — enforcement takes precedence, so we
  //    return its response verbatim. A permit is a `NextResponse.next()`, which
  //    Next.js marks with the internal `x-middleware-next: 1` header.
  const permitted = checkpointResponse.headers.get('x-middleware-next') === '1';
  if (!permitted) {
    return checkpointResponse;
  }

  // 3. Permit: layer this app's existing behavior on top of the pass-through
  //    response, preserving the Checkpoint verdict headers + cookie it set.
  const response = checkpointResponse;
  const pathname = request.nextUrl.pathname;

  // Security headers
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Custom header to track proxy execution
  response.headers.set('X-Middleware-Executed', 'true');

  // Logging for demonstration (in production, use a proper logging service)
  console.log(`[Proxy] ${request.method} ${pathname} - ${new Date().toISOString()}`);

  // Example: Block access to /admin paths (demonstration only)
  if (pathname.startsWith('/admin')) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    const redirect = NextResponse.redirect(url);
    carryCheckpointVerdict(response, redirect);
    redirect.headers.set('X-Blocked-Path', pathname);
    return redirect;
  }

  // Example: Add custom header for API routes
  if (pathname.startsWith('/api/') || pathname.startsWith('/quotes/')) {
    response.headers.set('X-API-Version', '1.0');
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon files
     * - public files (images, etc.)
     */
    '/((?!_next/static|_next/image|favicon.svg|favicon.ico|images|.*\\.svg|.*\\.png|.*\\.jpg).*)',
  ],
};
