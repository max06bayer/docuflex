// Dedicated receiver on the Docuflex host. Only /api/feedback is routed here;
// feedback files are private and persistent, and never exposed by HTTP.
import { createServer } from 'node:http';
import { FEEDBACK_MAX_BYTES, feedbackAllowed, purgeOldFeedback, saveFeedback, validateFeedback } from '../src/lib/server/feedback.js';

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(body));
  };
  if (request.url !== '/api/feedback') return send(404, { error: 'Not found.' });
  if (request.method !== 'POST') return send(405, { error: 'Use the feedback form to submit feedback.' });
  if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Send JSON.' });
  const forwarded = request.headers['x-forwarded-for'];
  const address = (typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : '') || request.socket.remoteAddress || 'unknown';
  if (!feedbackAllowed(address)) return send(429, { error: 'Too many submissions. Please try again later.' });
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > FEEDBACK_MAX_BYTES) { send(413, { error: 'Your feedback is too long.' }); request.resume(); return; }
      chunks.push(chunk);
    }
    let feedback;
    try { feedback = validateFeedback(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { return send(400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }); }
    const id = await saveFeedback(feedback);
    send(201, { id });
  } catch {
    send(503, { error: 'Could not save your feedback. Please try again.' });
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxRequestsPerSocket = 100;
await purgeOldFeedback();
setInterval(() => purgeOldFeedback().catch(() => {}), 3_600_000).unref();
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
