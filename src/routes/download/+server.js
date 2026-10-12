import { redirect } from '@sveltejs/kit';
import { ANALYTICS_ENABLED, buildRecord, isBot, writeRecord } from '$lib/server/analytics.js';

const RELEASES_URL = 'https://github.com/max06bayer/docuflex/releases/latest';

/** Counts release downloads, then forwards the visitor to the GitHub release page. */
/** @type {import('./$types').RequestHandler} */
export async function GET({ request, getClientAddress }) {
  if (ANALYTICS_ENABLED && !isBot(request.headers.get('user-agent'))) {
    try {
      await writeRecord(
        await buildRecord({ request, address: getClientAddress(), type: 'download', page: '/download' })
      );
    } catch (error) {
      // A failed analytics write must never block the download itself.
      console.error('analytics write failed', error);
    }
  }
  redirect(302, RELEASES_URL);
}
