// Cookie-free page analytics. Nothing is stored in the browser; the server
// hashes visitors per day. Visitors who send Do Not Track or Global Privacy
// Control are not measured at all.

const ENDPOINT = '/api/analytics/collect';

const pageView = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

function optedOut() {
  return navigator.doNotTrack === '1' || /** @type {any} */ (navigator).globalPrivacyControl === true;
}

/** @param {Record<string, unknown>} payload */
function send(payload) {
  if (optedOut()) return;
  const body = JSON.stringify({ ...payload, pv: pageView, lang: navigator.language });
  const blob = new Blob([body], { type: 'application/json' });
  if (!navigator.sendBeacon?.(ENDPOINT, blob)) {
    fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
  }
}

function referrerHost() {
  try {
    return document.referrer ? new URL(document.referrer).host : '';
  } catch {
    return '';
  }
}

/** @param {string} name @param {Record<string, unknown>} [extra] */
export function trackEvent(name, extra = {}) {
  send({ type: 'event', name, page: location.pathname, ...extra });
}

/**
 * Sends a pageview now and reports visible time and maximum scroll depth when
 * the page is hidden or closed. Returns a cleanup function.
 * @param {string} page
 */
export function trackPage(page) {
  if (typeof window === 'undefined') return () => {};
  send({ type: 'pageview', page, ref: referrerHost() });

  let visibleMs = 0;
  let visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
  let maxScroll = 0;

  const flush = () => {
    if (visibleSince !== null) {
      visibleMs += performance.now() - visibleSince;
      visibleSince = null;
    }
    const scroll = document.documentElement.scrollHeight > innerHeight
      ? Math.round(((scrollY + innerHeight) / document.documentElement.scrollHeight) * 100)
      : 100;
    maxScroll = Math.max(maxScroll, Math.min(scroll, 100));
    if (visibleMs > 0 || maxScroll > 0) {
      send({ type: 'engagement', page, ms: Math.round(visibleMs), scroll: maxScroll });
    }
    visibleMs = 0;
    visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
    else if (visibleSince === null) visibleSince = performance.now();
  };
  const onScroll = () => {
    const height = document.documentElement.scrollHeight;
    if (height > 0) maxScroll = Math.max(maxScroll, Math.round(((scrollY + innerHeight) / height) * 100));
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pagehide', flush);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pagehide', flush);
    flush();
  };
}
