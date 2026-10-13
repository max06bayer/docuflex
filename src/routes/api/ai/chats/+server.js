import { aiAvailable } from '$lib/server/ai.js';
import { deleteChat, listChats, readChat, saveChat } from '$lib/server/ai-chats.js';
import { isLocalRequest } from '$lib/server/mcp-bridge.js';

/** @param {Request} request @param {URL} url */
async function allowed(request, url) {
  return isLocalRequest(request, url) && (await aiAvailable());
}

/** Lists saved chats, or returns one with ?id=. */
/** @type {import('./$types').RequestHandler} */
export async function GET({ request, url }) {
  if (!(await allowed(request, url))) return new Response('Not found', { status: 404 });
  const id = url.searchParams.get('id');
  try {
    return Response.json(id ? await readChat(id) : { chats: await listChats() });
  } catch {
    return Response.json({ error: 'Chat not found.' }, { status: 404 });
  }
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, url }) {
  if (!(await allowed(request, url))) return new Response('Not found', { status: 404 });
  try {
    await saveChat(await request.json());
    return Response.json({ saved: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Could not save the chat.' }, { status: 400 });
  }
}

/** @type {import('./$types').RequestHandler} */
export async function DELETE({ request, url }) {
  if (!(await allowed(request, url))) return new Response('Not found', { status: 404 });
  try {
    await deleteChat(url.searchParams.get('id') ?? '');
    return Response.json({ deleted: true });
  } catch {
    return Response.json({ error: 'Invalid chat id.' }, { status: 400 });
  }
}
