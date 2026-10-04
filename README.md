# Email → Agent

A self-hosted, Gmail-style inbox that runs entirely on Cloudflare — one Worker
handles inbound mail parsing, storage, a live dashboard, and a remote MCP
server so Claude (or any MCP client) can read your inbox directly.

No Railway, no separate forwarder, no local process. Everything lives in this
one repo and deploys as a single Cloudflare Worker.

| Piece | Runs on |
|---|---|
| Inbound mail parsing (`postal-mime`) + storage | This Worker's `email()` handler → D1 |
| Database | Cloudflare D1 (SQLite) |
| Live dashboard push | Durable Object, WebSocket Hibernation API + `alarm()` |
| Dashboard UI | Static `public/index.html`, served via Workers Assets |
| MCP server | Same Worker, mounted at `/mcp` (Streamable HTTP) |
| Optional AI triage | Any OpenAI-compatible endpoint (`HERMES_API_URL`) |

---

## Features

**Dashboard (`public/index.html`)**
- Gmail-style two-pane inbox: list on the left, reading pane on the right
- Real-time updates over WebSocket — new mail slides in without a refresh
- Collapsed-by-default email header: shows `to <recipient-local-part>` and
  the time, with a small chevron to expand the full from/to/date block —
  keeps the reading pane compact instead of always showing three metadata
  lines
- Opening an email is reflected in the URL (`#<email-id>`), so **refreshing
  the page reopens the same email** instead of dropping you back to the
  inbox list. Press **Esc** to close it and return to the inbox (also clears
  the URL). A stale/deleted id in the URL is cleaned up automatically.
- A short boot splash (your own envelope icon, pulsing) is shown until the
  first batch of emails has actually loaded over the WebSocket, so you never
  see a flash of an empty inbox. It fades out once and won't reappear on
  later reconnects — a small dot in the header shows live/reconnecting
  status after that.
- Sign-in screen (same `EMAIL_WEBHOOK_SECRET`) with session cookie and a sign-out button
- Read/unread, star, archive (with undo), bulk actions, search, and a
  filter panel (sender, domain, field, date range, has-attachment)
- Light/dark theme toggle (persisted in `localStorage`)
- HTML email bodies render in a sandboxed `<iframe>` (no scripts, no
  same-origin) so nothing in an email can touch the dashboard page

**Backend**
- Inbound mail is parsed with `postal-mime`; the `From`/`To` header display
  names are preserved (e.g. `GitHub <noreply@github.com>`), not just the
  bare envelope address
- Optional AI triage: every inbound email can be sent to an
  OpenAI-compatible endpoint for a 1–3 sentence summary, shown as a tag on
  the email
- Optional webhook forwarding of every inbound email to another service

**MCP**
- A Streamable HTTP MCP server at `/mcp`, backed by a Durable Object,
  exposing six read tools over your mail archive (see below)

---

## Prerequisites

- A Cloudflare account with a domain you control (Email Routing needs an
  actual domain — you can't receive mail on `*.workers.dev`)
- Node.js 18+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed
  as a dev dependency — no separate global install needed)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

This also installs **Wrangler** (Cloudflare's CLI) locally as a dev
dependency — you don't need a separate global install. All commands below
use `npx wrangler ...`, which runs the local copy automatically.

If you ever want it available globally on your machine too (optional):

```bash
npm install -g wrangler
```

Then log in so Wrangler can act on your Cloudflare account:

```bash
npx wrangler login
```

This opens a browser window to authorize the CLI. Verify it worked with:

```bash
npx wrangler whoami
```

### 2. Create the D1 database

```bash
npx wrangler d1 create email-agent-db
```

This prints a `database_id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "email-agent-db"
database_id = "your-actual-id-here"
```

Then create the schema on the remote database:

```bash
npm run db:migrate:remote
```

### 3. Set secrets

```bash
npx wrangler secret put EMAIL_WEBHOOK_SECRET
```

Use a long random value, e.g. generate one with:

```bash
openssl rand -hex 32
# or, without openssl:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Secrets are **write-only** — once set, Wrangler and the Cloudflare dashboard
will never show you the value again. If you forget it, don't try to recover
it; just run `wrangler secret put` again with a new value and update
anywhere that references it (MCP config, webhook callers, etc.).

Optional secrets:

```bash
npx wrangler secret put AGENT_WEBHOOK_URL   # forward every inbound email as JSON to another service
npx wrangler secret put HERMES_API_URL      # OpenAI-compatible endpoint for auto-triage
npx wrangler secret put HERMES_API_KEY      # bearer token for HERMES_API_URL, if it needs one
npx wrangler secret put HERMES_MODEL        # model name sent to HERMES_API_URL (default: "hermes-3")
```

### 4. Deploy

```bash
npm run deploy
```

This prints your Worker's URL, something like:

```
https://email-agent-worker.<your-subdomain>.workers.dev
```

### 5. Point real email at the Worker (Cloudflare Email Routing)

In the Cloudflare dashboard, on the domain you want to receive mail for:

1. Go to **Email → Email Routing** and enable it (Cloudflare will ask you to
   confirm/add MX and related DNS records — do that first).
2. Add a **Routing Rule**: `*@yourdomain.com` → **Send to a Worker** →
   `email-agent-worker` (this Worker).

That's it — no separate forwarding Worker, no `RAILWAY_WEBHOOK_URL`. Parsing
and storage happen inside this Worker's `email()` handler, straight into D1.

Because the rule is a catch-all (`*@yourdomain.com`), *any* local part works
— `github@yourdomain.com`, `random-test-123@yourdomain.com`, etc. — which
makes this handy as a personal, private "catch-all" inbox for signups and
verification codes.

### 6. Test it

```bash
curl https://<your-worker>.workers.dev/api/status
```

Send an email to any address `@yourdomain.com`, then open the dashboard at
`https://<your-worker>.workers.dev/` — it should appear live within a
couple of seconds.

---

## Connecting Claude to your inbox (MCP)

The `/mcp` endpoint is protected by the same `EMAIL_WEBHOOK_SECRET`. It
accepts the secret two ways, since not every MCP client supports custom
headers:

- Header: `x-email-secret: <secret>`
- Query string: `?secret=<secret>`

### Claude Code

```bash
claude mcp add --transport http email-agent https://<your-worker>.workers.dev/mcp \
  --header "x-email-secret: <secret>"
```

Add `--scope user` if you want it available in every project (default scope
is `local`, i.e. only the project/folder you ran the command from):

```bash
claude mcp add --transport http --scope user email-agent https://<your-worker>.workers.dev/mcp \
  --header "x-email-secret: <secret>"
```

Verify it connected with `/mcp` inside a Claude Code session — you should
see `email-agent` listed as connected, with its tools available.

### Claude.ai / Claude Desktop (custom connector)

Go to **Settings → Connectors → Add custom connector** and paste:

```
https://<your-worker>.workers.dev/mcp?secret=<secret>
```

(Header-based auth for custom connectors is a limited beta feature on
claude.ai; the query-string secret works everywhere, which is why the
Worker supports both.)

### Available tools

| Tool | Purpose |
|---|---|
| `list_recent_emails` | Most recent emails, newest first |
| `get_email` | Full content (including body) of one email by id |
| `list_emails_by_domain` | Emails from a given sender domain |
| `search_emails` | Keyword search, optionally restricted to one field |
| `list_emails_in_range` | Emails received within a date/time range |
| `list_emails` | Combine any of the above filters in one call |

---

## HTTP API reference

Dashboard routes (`/ws`, `/emails*`) accept either the login session cookie or
the `x-email-secret` header. `/api/*`, `/webhook/email`, and `/mcp` require
`EMAIL_WEBHOOK_SECRET` (header, or `?secret=` for `/mcp`) when it's set.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | — | Dashboard UI (static assets) |
| GET | `/ws` | session or secret | Dashboard WebSocket (live updates) |
| GET | `/emails` | session or secret | Recent emails (used by the dashboard) |
| GET | `/emails/search` | session or secret | Filtered emails (used by the dashboard) |
| POST | `/emails/:id/read` | session or secret | Mark read/unread |
| POST | `/emails/:id/star` | session or secret | Star/unstar |
| POST | `/emails/:id/archive` | session or secret | Archive/unarchive |
| POST | `/auth/login` | — | Exchange the secret for a dashboard session cookie |
| POST | `/auth/logout` | — | Clear the session cookie |
| GET | `/auth/check` | session or secret | 200 if signed in, 401 otherwise |
| GET | `/api/status` | — | Health check |
| GET | `/api/emails` | secret | Recent emails (external integrations) |
| GET | `/api/emails/:id` | secret | Single email by id |
| GET | `/api/emails/search` | secret | Filtered emails (external integrations) |
| POST | `/webhook/email` | secret | Ingest an email from JSON (alternative to native Email Routing) |
| ANY | `/mcp` | secret | MCP server (Streamable HTTP) |

> **Dashboard login:** when `EMAIL_WEBHOOK_SECRET` is set, the web dashboard
> shows a sign-in screen and asks for that same secret. On success the Worker
> sets an `HttpOnly; Secure; SameSite=Strict` session cookie (30 days) that
> covers the dashboard's `fetch` calls and its WebSocket. Rotating the secret
> invalidates every existing session. If no secret is configured, the
> dashboard stays open (handy for local dev) — so set one before deploying.
>
> This only guards the dashboard routes (`/ws`, `/emails*`). `/mcp` and
> `/api/*` have their own header / query-string check and ignore the cookie,
> so Claude Desktop, Claude Code and scripts are unaffected by the web login.
> Scripts can also call `/emails*` directly with the `x-email-secret` header.>
> Some webviews (for example the desktop app, which shows the dashboard inside
> an iframe) refuse to keep third-party cookies. For those, a successful login
> also returns the same session token in its JSON response; the page keeps it
> in `localStorage` and sends it as an `x-email-session` header (and as
> `?session=` on the `/ws` handshake only, since browsers can't set WebSocket
> headers). The desktop app skips the form entirely by posting its stored
> secret to the dashboard page.

---

## Local development

```bash
npm run dev
npm run db:migrate   # applies schema.sql to the local D1 (a local SQLite file, not production)
```

`wrangler dev` runs the `fetch` handler, the `email` handler, and the
dashboard, all locally. Two ways to simulate inbound mail without a real
Email Routing setup:

```bash
# Simulate the JSON webhook path:
curl -X POST http://localhost:8787/webhook/email \
  -H "content-type: application/json" \
  -H "x-email-secret: <your local secret, if set>" \
  -d '{"from":"test@example.com","to":"you@yourdomain.com","subject":"hi","text":"hello"}'

# Exercise the alarm-driven periodic refresh:
wrangler dev --test-scheduled
```

---

## Project structure

```
email-agent-worker/
├── src/
│   ├── index.js          # Worker entry: email() handler, HTTP routes, MCP mount
│   ├── db.js              # D1 data layer (schema, queries, filters)
│   ├── dashboard-hub.js   # Durable Object: WebSocket hub + periodic refresh alarm
│   └── mcp.js             # MCP tool definitions (EmailMcp)
├── public/
│   └── index.html         # Dashboard UI (single file, no build step)
├── schema.sql              # D1 schema
├── wrangler.toml           # Worker + bindings config
└── package.json
```

---

## Notes / gotchas

- **`BROADCAST_INTERVAL_MS`** (in `wrangler.toml` under `[vars]`, default
  `10000` = 10s): how often the dashboard gets a full periodic refresh, on
  top of the instant push on new mail. Implemented with the Durable
  Object's `alarm()`, since Workers don't have `setInterval`.
- **MCP Durable Object binding name matters.** `McpAgent.serve(path)`
  defaults to looking up a binding literally named `MCP_OBJECT`. This
  project's binding is named `EMAIL_MCP` instead, so `src/index.js` passes
  it explicitly: `EmailMcp.serve('/mcp', { binding: 'EMAIL_MCP' })`. If you
  rename the binding in `wrangler.toml`, update that call to match, or
  you'll get a cryptic `Invalid binding` error when a client tries to
  connect.
- For real production use instead of a shared secret, you can put
  `agents/mcp` behind proper OAuth via
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
