import {
  applySecurityHeaders,
  enterProtectedRoute,
  rejectsCrossSiteMutation,
  securityError
} from '$lib/server/request-security.js';

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
  if (event.url.pathname.startsWith('/api/') && rejectsCrossSiteMutation(event.request)) {
    return applySecurityHeaders(securityError(403, 'Cross-site document requests are not allowed.'), event.url);
  }

  /** @type {{ release?: () => void; response?: Response }} */
  let admission = {};
  if (event.request.method === 'POST') {
    let clientAddress = 'unknown';
    try {
      clientAddress = event.getClientAddress();
    } catch {
      // A missing trusted proxy header deliberately shares the conservative fallback bucket.
    }
    admission = enterProtectedRoute(event.url.pathname, clientAddress);
  }
  if (admission.response) return applySecurityHeaders(admission.response, event.url);

  try {
    return applySecurityHeaders(await resolve(event), event.url);
  } finally {
    admission.release?.();
  }
}
