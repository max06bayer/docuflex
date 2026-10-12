import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

/**
 * Relay between the local MCP endpoint (/mcp) and the open Docuflex window.
 * Tool calls are queued to the window over a server-sent event stream; the
 * window acknowledges each call right away, runs it with the editor's own
 * code and posts the result back.
 *
 * A stream whose page is gone does not always error on the server, so
 * windows send heartbeats, and a call nobody acknowledges within a few
 * seconds is moved to the next window instead of waiting for its timeout.
 *
 * State lives on globalThis so dev-server module reloads keep connections.
 */

/** @typedef {{ id: number; controller: ReadableStreamDefaultController<Uint8Array>; connectedAt: number; lastSeen: number }} AppClient */
/** @typedef {{ name: string; args: Record<string, unknown>; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; ackTimer?: ReturnType<typeof setTimeout>; clientId?: number; tried: Set<number> }} PendingCall */

const state = /** @type {{ enabled: boolean; clients: Map<number, AppClient>; pending: Map<string, PendingCall>; nextClientId: number; nextCallId: number; lastCall: { name: string; at: number } | null }} */ (
  /** @type {any} */ (globalThis).__docuflexMcp ??= {
    enabled: true,
    clients: new Map(),
    pending: new Map(),
    nextClientId: 1,
    nextCallId: 1,
    lastCall: null
  }
);

const encoder = new TextEncoder();
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** A window that has not checked in for this long is considered gone. */
const CLIENT_STALE_MS = 25_000;
/** How long a window has to acknowledge a call before it goes to the next one. */
const ACK_TIMEOUT_MS = 4_000;

/** The MCP server only exists in the desktop app (DOCUFLEX_MCP=1) and local development, never on the hosted web app. */
export function mcpAvailable() {
  return dev || env.DOCUFLEX_MCP === '1';
}

export function mcpEnabled() {
  return mcpAvailable() && state.enabled;
}

/** @param {boolean} enabled */
export function setMcpEnabled(enabled) {
  state.enabled = enabled;
  if (!enabled) {
    for (const [id, call] of state.pending) {
      clearTimeout(call.timer);
      clearTimeout(call.ackTimer);
      call.reject(new Error('The Docuflex MCP server was turned off.'));
      state.pending.delete(id);
    }
  }
}

function pruneClients() {
  const now = Date.now();
  for (const [id, client] of state.clients) {
    if (now - client.lastSeen > CLIENT_STALE_MS) dropClient(id);
  }
}

/** @param {number} id */
function dropClient(id) {
  const client = state.clients.get(id);
  if (!client) return;
  state.clients.delete(id);
  try {
    client.controller.close();
  } catch {
    // Already closed.
  }
}

export function mcpStatus() {
  pruneClients();
  return {
    available: mcpAvailable(),
    enabled: mcpEnabled(),
    connectedApps: state.clients.size,
    lastCall: state.lastCall
  };
}

/**
 * Requests must come from this machine: the Host has to be loopback (blocks
 * DNS rebinding) and a browser Origin, if sent, must be loopback as well, so
 * an open website can't drive the local server.
 * @param {Request} request @param {URL} url
 */
export function isLocalRequest(request, url) {
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** @param {AppClient} client @param {unknown} payload */
function send(client, payload) {
  try {
    client.controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    return true;
  } catch {
    state.clients.delete(client.id);
    return false;
  }
}

/** Opens the event stream the Docuflex window listens on for tool calls. */
export function openAppStream() {
  /** @type {AppClient | null} */
  let client = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let keepAlive;
  return new ReadableStream({
    start(controller) {
      const now = Date.now();
      client = { id: state.nextClientId++, controller, connectedAt: now, lastSeen: now };
      state.clients.set(client.id, client);
      send(client, { type: 'ready', clientId: client.id });
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15_000);
    },
    cancel() {
      clearInterval(keepAlive);
      if (client) state.clients.delete(client.id);
    }
  });
}

/** @param {number} clientId */
export function markClientAlive(clientId) {
  const client = state.clients.get(Number(clientId));
  if (client) client.lastSeen = Date.now();
  return Boolean(client);
}

/** Sends a pending call to the newest live window it has not been tried on. @param {string} id */
function dispatch(id) {
  const call = state.pending.get(id);
  if (!call) return;
  pruneClients();
  const candidates = [...state.clients.values()]
    .filter((client) => !call.tried.has(client.id))
    .sort((left, right) => right.connectedAt - left.connectedAt);
  for (const client of candidates) {
    call.tried.add(client.id);
    if (!send(client, { type: 'call', id, name: call.name, args: call.args })) continue;
    call.clientId = client.id;
    call.ackTimer = setTimeout(() => {
      // Nobody picked it up: that window is gone. Forget it and try the next.
      dropClient(client.id);
      dispatch(id);
    }, ACK_TIMEOUT_MS);
    return;
  }
  clearTimeout(call.timer);
  state.pending.delete(id);
  call.reject(new Error('No Docuflex window is connected. Open the Docuflex app (or the editor at this address) and keep it running.'));
}

/**
 * Runs a tool in the most recently connected live Docuflex window.
 * @param {string} name @param {Record<string, unknown>} args @param {number} [timeoutMs]
 */
export function callApp(name, args, timeoutMs = 180_000) {
  const id = String(state.nextCallId++);
  state.lastCall = { name, at: Date.now() };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const call = state.pending.get(id);
      if (call) clearTimeout(call.ackTimer);
      state.pending.delete(id);
      reject(new Error(`Docuflex did not finish "${name}" in time.`));
    }, timeoutMs);
    state.pending.set(id, { name, args, resolve, reject, timer, tried: new Set() });
    dispatch(id);
  });
}

/** @param {string} id @param {number} clientId */
export function acknowledgeAppCall(id, clientId) {
  markClientAlive(clientId);
  const call = state.pending.get(String(id));
  if (!call) return false;
  clearTimeout(call.ackTimer);
  call.ackTimer = undefined;
  return true;
}

/** @param {{ id: string; ok: boolean; result?: unknown; error?: string; clientId?: number }} message */
export function resolveAppCall(message) {
  if (message.clientId !== undefined) markClientAlive(message.clientId);
  const call = state.pending.get(String(message.id));
  if (!call) return false;
  clearTimeout(call.timer);
  clearTimeout(call.ackTimer);
  state.pending.delete(String(message.id));
  if (message.ok) call.resolve(message.result);
  else call.reject(new Error(message.error || 'The tool failed.'));
  return true;
}
