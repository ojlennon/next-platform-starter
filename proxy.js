import { NextResponse } from 'next/server';
import { withCheckpointApi } from '@kya-os/checkpoint-nextjs/api-middleware';

/**
 * Checkpoint middleware enforcement, merged with this app's existing
 * request-handling logic (previously in `middleware.js`).
 *
 * Netlify packages Next.js proxy code as an Edge Function. Use Checkpoint's
 * SaaS gateway integration here so the generated bundle does not include the
 * Node-only local WASM engine (which loads its binary through `fs`).
 *
 * Configuration comes from environment variables — see `.env.local` /
 * `.env.example`. `apiKey` is required by the gateway.
 */
const checkpoint = withCheckpointApi({
  // Required. Set CHECKPOINT_API_KEY in Netlify with the Functions scope.
  apiKey: process.env.CHECKPOINT_API_KEY,
  // Use Checkpoint's lower-latency edge detection gateway.
  useEdge: true,
});

/**
 * Copy Checkpoint's response metadata and cookies from a pass-through response
 * onto a new terminal response (e.g. a redirect).
 */
function carryCheckpointVerdict(from, to) {
  from.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith('x-checkpoint') || normalizedKey.startsWith('kya-')) {
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
  //    response, preserving any Checkpoint metadata it set.
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
