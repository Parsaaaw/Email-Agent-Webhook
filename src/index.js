import PostalMime from 'postal-mime';
import * as db from './db.js';
import { broadcast } from './dashboard-hub.js';
import { EmailMcp } from './mcp.js';

export { DashboardHub } from './dashboard-hub.js';
export { EmailMcp } from './mcp.js';

const MAX_RECENT = 50;

function checkSecret(request, env) {
  if (!env.EMAIL_WEBHOOK_SECRET) return true; // no secret configured yet, allow through
  return request.headers.get('x-email-secret') === env.EMAIL_WEBHOOK_SECRET;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// PostalMime parses the actual From/To headers into { name, address } (or an
// array of those for To/Cc). message.from / message.to from Email Routing are
// just the bare envelope addresses with no display name — using those alone
// is why "GitHub <noreply@github.com>" was showing up as plain
// "noreply@github.com". Prefer the parsed header, fall back to the envelope
// string if parsing didn't yield one.
function formatAddr(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  const { name, address } = addr;
  return name ? `${name} <${address}>` : address || '';
}

function pickFrom(parsed, envelopeFrom) {
  return formatAddr(parsed.from) || envelopeFrom || '';
}

function pickTo(parsed, envelopeTo) {
  const first = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
  return formatAddr(first) || envelopeTo || '';
}

async function triageWithHermes(env, email) {
  if (!env.HERMES_API_URL) return null;
  const body = (email.text || email.html || '').slice(0, 4000);
  const resp = await fetch(`${env.HERMES_API_URL.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.HERMES_API_KEY ? { authorization: `Bearer ${env.HERMES_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: env.HERMES_MODEL || 'hermes-3',
      messages: [
        { role: 'system', content: 'You triage incoming emails. Reply with a 1-3 sentence summary and flag anything that needs action. Be concise, no preamble.' },
        { role: 'user', content: `From: ${email.from}\nSubject: ${email.subject}\n\n${body}` },
      ],
      max_tokens: 250,
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(`Hermes API returned ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function ingestEmail(env, ctx, email) {
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    ...email,
  };

  try {
    await db.insertEmail(env, record);
  } catch (err) {
    console.error('Failed to persist email to db:', err);
  }

  await broadcast(env, { type: 'new_email', email: record });

  if (env.AGENT_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.AGENT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(email),
      }).catch((err) => console.error('Failed to forward to agent webhook:', err))
    );
  }

  if (env.HERMES_API_URL) {
    ctx.waitUntil(
      triageWithHermes(env, record)
        .then(async (summary) => {
          if (!summary) return;
          await db.setAgentSummary(env, record.id, summary);
          await broadcast(env, { type: 'email_update', id: record.id, agentSummary: summary });
        })
        .catch((err) => console.error('Hermes triage failed:', err))
    );
  }

  return record;
}

export default {
  // Inbound Email Routing → Worker trigger. Configure a catch-all rule
  // (*@yourdomain.com → Send to a Worker → this worker) in the Cloudflare
  // dashboard. Replaces the old separate cloudflare-worker/ forwarder —
  // no Railway hop, parsing + storage happen in the same place.
  async email(message, env, ctx) {
    const parser = new PostalMime();
    const parsed = await parser.parse(message.raw);

    const email = {
      from: pickFrom(parsed, message.from),
      to: pickTo(parsed, message.to),
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: parsed.html || '',
      attachments: (parsed.attachments || []).map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.content ? a.content.byteLength : undefined,
      })),
    };

    try {
      await ingestEmail(env, ctx, email);
    } catch (err) {
      console.error('Failed to ingest inbound email:', err);
      message.setReject(`Internal error while ingesting: ${err.message}`);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Remote MCP mount point ---
    // claude mcp add --transport http email-agent https://<worker>.workers.dev/mcp
    if (url.pathname.startsWith('/mcp')) {
      const secretOk =
        !env.EMAIL_WEBHOOK_SECRET ||
        request.headers.get('x-email-secret') === env.EMAIL_WEBHOOK_SECRET ||
        url.searchParams.get('secret') === env.EMAIL_WEBHOOK_SECRET; // MCP clients can't always set custom headers
      if (!secretOk) return json({ error: 'unauthorized' }, 401);
      // McpAgent.serve() defaults to a Durable Object binding literally
      // named MCP_OBJECT — our wrangler.toml binds this class as EMAIL_MCP,
      // so that default lookup fails ("Invalid binding") unless we tell it
      // the actual binding name explicitly.
      return EmailMcp.serve('/mcp', { binding: 'EMAIL_MCP' }).fetch(request, env, ctx);
    }

    // --- Live dashboard WebSocket, proxied straight to the singleton Durable Object ---
    if (url.pathname === '/ws') {
      const id = env.DASHBOARD_HUB.idFromName('singleton');
      const stub = env.DASHBOARD_HUB.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/api/status' && request.method === 'GET') {
      const recent = await db.listRecent(env, 1);
      return json({ ok: true, service: 'email-agent-worker', dbConnected: true, hasEmails: recent.length > 0 });
    }

    if (url.pathname === '/emails' && request.method === 'GET') {
      return json(await db.listRecent(env, MAX_RECENT));
    }

    if (url.pathname === '/emails/search' && request.method === 'GET') {
      const q = url.searchParams;
      const results = await db.queryEmails(env, {
        sender: q.get('sender'),
        domain: q.get('domain'),
        since: q.get('since'),
        until: q.get('until'),
        hasAttachment: q.get('has_attachment') === 'true',
        keyword: q.get('keyword'),
        field: q.get('field'),
        limit: q.get('limit'),
        includeArchived: q.get('include_archived') === 'true',
      });
      return json(results);
    }

    const idActionMatch = url.pathname.match(/^\/emails\/([^/]+)\/(read|star|archive)$/);
    if (idActionMatch && request.method === 'POST') {
      const [, id, action] = idActionMatch;
      const body = await request.json().catch(() => ({}));
      try {
        if (action === 'read') {
          const isRead = body.isRead !== false;
          await db.setRead(env, id, isRead);
          await broadcast(env, { type: 'email_read', id, isRead });
        } else if (action === 'star') {
          const starred = !!body.starred;
          await db.setStarred(env, id, starred);
          await broadcast(env, { type: 'email_star', id, starred });
        } else if (action === 'archive') {
          const archived = body.archived !== false;
          await db.setArchived(env, id, archived);
          await broadcast(env, { type: 'email_archive', id, archived });
        }
      } catch (err) {
        console.error(`Failed to update (${action}):`, err);
        return json({ error: 'failed to update' }, 500);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/webhook/email' && request.method === 'POST') {
      if (!checkSecret(request, env)) return json({ error: 'invalid secret' }, 401);
      const email = await request.json();
      console.log('Received email:', { from: email.from, to: email.to, subject: email.subject });
      const record = await ingestEmail(env, ctx, email);
      return json({ ok: true, id: record.id });
    }

    if (url.pathname === '/api/emails' && request.method === 'GET') {
      if (!checkSecret(request, env)) return json({ error: 'invalid secret' }, 401);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, MAX_RECENT);
      return json(await db.listRecent(env, limit));
    }

    const apiEmailIdMatch = url.pathname.match(/^\/api\/emails\/([^/]+)$/);
    if (apiEmailIdMatch && request.method === 'GET' && url.pathname !== '/api/emails/search') {
      if (!checkSecret(request, env)) return json({ error: 'invalid secret' }, 401);
      const found = await db.getById(env, apiEmailIdMatch[1]);
      if (!found) return json({ error: 'not found' }, 404);
      return json(found);
    }

    if (url.pathname === '/api/emails/search' && request.method === 'GET') {
      if (!checkSecret(request, env)) return json({ error: 'invalid secret' }, 401);
      const q = url.searchParams;
      const results = await db.queryEmails(env, {
        sender: q.get('sender'),
        domain: q.get('domain'),
        since: q.get('since'),
        until: q.get('until'),
        hasAttachment: q.get('has_attachment') === 'true',
        keyword: q.get('keyword'),
        field: q.get('field'),
        limit: q.get('limit'),
      });
      return json(results);
    }

    // Anything else (including "/" and static files) falls through to the
    // Workers Assets binding automatically — see wrangler.toml [assets].
    return env.ASSETS.fetch(request);
  },
};
