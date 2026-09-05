import { DurableObject } from 'cloudflare:workers';
import * as db from './db.js';

const MAX_RECENT = 50;

// One singleton instance of this DO holds every dashboard WebSocket connection.
// Uses the WebSocket Hibernation API so idle connections don't keep the DO
// billed as "active" — sockets survive hibernation via state.getWebSockets().
export class DashboardHub extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal call from the main Worker to push an event to every connected client.
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const msg = await request.text();
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(msg);
        } catch {
          // socket gone stale; ignore
        }
      }
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);

    // Kick off the periodic refresh loop (idempotent — alarm is a no-op if already set).
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      const intervalMs = Number(this.env.BROADCAST_INTERVAL_MS || 10000);
      await this.state.storage.setAlarm(Date.now() + intervalMs);
    }

    const recent = await db.listRecent(this.env, MAX_RECENT);
    server.send(JSON.stringify({ type: 'init', emails: recent }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws, _message) {
    // Dashboard doesn't send anything meaningful over the socket today.
  }

  async webSocketClose(ws, _code, _reason, _wasClean) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  async webSocketError(ws, _error) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  // Wakes up periodically (independent of new mail arriving) to push a full
  // refresh, same as the old setInterval(..., BROADCAST_INTERVAL_MS) in server.js.
  async alarm() {
    const sockets = this.state.getWebSockets();
    if (sockets.length > 0) {
      const recent = await db.listRecent(this.env, MAX_RECENT);
      const msg = JSON.stringify({ type: 'refresh', emails: recent, serverTime: new Date().toISOString() });
      for (const ws of sockets) {
        try {
          ws.send(msg);
        } catch {
          // ignore stale socket
        }
      }
      const intervalMs = Number(this.env.BROADCAST_INTERVAL_MS || 10000);
      await this.state.storage.setAlarm(Date.now() + intervalMs);
    }
    // If nobody's connected, just let the alarm lapse — the next new
    // WebSocket connection will re-arm it.
  }
}

// Helper used by the main Worker to grab the one-and-only hub instance.
export function getHubStub(env) {
  const id = env.DASHBOARD_HUB.idFromName('singleton');
  return env.DASHBOARD_HUB.get(id);
}

export async function broadcast(env, message) {
  const stub = getHubStub(env);
  await stub.fetch('https://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(message),
  });
}
