// D1 (SQLite) data layer — replaces the old Postgres db.js.
// Column names avoid reserved words (from_addr/to_addr instead of "from"/"to"),
// but toRecord() maps them back to from/to so the API + UI stay unchanged.

const MAX_QUERY_LIMIT = 100;

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  // NOTE: D1's exec() splits its input on newlines (not semicolons), so a
  // multi-line CREATE TABLE fed to exec() gets torn into broken fragments
  // and throws. prepare().run() sends the whole string as one statement,
  // so multi-line SQL is safe there.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      from_addr TEXT,
      to_addr TEXT,
      subject TEXT,
      text_body TEXT,
      html_body TEXT,
      attachments TEXT,
      agent_summary TEXT,
      read_at TEXT,
      starred INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS emails_received_at_idx ON emails (received_at DESC)`
  ).run();
  schemaReady = true;
}

function toRecord(row) {
  if (!row) return null;
  let attachments = [];
  try {
    attachments = row.attachments ? JSON.parse(row.attachments) : [];
  } catch {
    attachments = [];
  }
  return {
    id: row.id,
    receivedAt: row.received_at,
    from: row.from_addr,
    to: row.to_addr,
    subject: row.subject,
    text: row.text_body,
    html: row.html_body,
    attachments,
    agentSummary: row.agent_summary || undefined,
    isRead: !!row.read_at,
    starred: !!row.starred,
    archived: !!row.archived_at,
  };
}

async function insertEmail(env, record) {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO emails (id, received_at, from_addr, to_addr, subject, text_body, html_body, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      record.id,
      record.receivedAt,
      record.from || null,
      record.to || null,
      record.subject || null,
      record.text || null,
      record.html || null,
      JSON.stringify(record.attachments || [])
    )
    .run();
}

async function setAgentSummary(env, id, summary) {
  await ensureSchema(env);
  await env.DB.prepare(`UPDATE emails SET agent_summary = ? WHERE id = ?`).bind(summary, id).run();
}

async function setRead(env, id, isRead) {
  await ensureSchema(env);
  await env.DB.prepare(`UPDATE emails SET read_at = ? WHERE id = ?`)
    .bind(isRead ? new Date().toISOString() : null, id)
    .run();
}

async function setStarred(env, id, starred) {
  await ensureSchema(env);
  await env.DB.prepare(`UPDATE emails SET starred = ? WHERE id = ?`).bind(starred ? 1 : 0, id).run();
}

async function setArchived(env, id, archived) {
  await ensureSchema(env);
  await env.DB.prepare(`UPDATE emails SET archived_at = ? WHERE id = ?`)
    .bind(archived ? new Date().toISOString() : null, id)
    .run();
}

async function listRecent(env, limit = 20, includeArchived = false) {
  await ensureSchema(env);
  const sql = `SELECT * FROM emails ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY received_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(limit).all();
  return results.map(toRecord);
}

async function getById(env, id) {
  await ensureSchema(env);
  const row = await env.DB.prepare(`SELECT * FROM emails WHERE id = ?`).bind(id).first();
  return toRecord(row);
}

// Flexible search/filter used by /api/emails/search, /emails/search and the MCP tools.
// filters: { sender, domain, since, until, hasAttachment, keyword, field, limit, includeArchived }
async function queryEmails(env, filters = {}) {
  await ensureSchema(env);
  const where = [];
  const params = [];

  if (filters.sender) {
    where.push(`LOWER(from_addr) LIKE ?`);
    params.push('%' + filters.sender.toLowerCase() + '%');
  }
  if (filters.domain) {
    where.push(`LOWER(from_addr) LIKE ?`);
    params.push('%@' + filters.domain.replace(/^@/, '').toLowerCase());
  }
  if (filters.since) {
    where.push(`received_at >= ?`);
    params.push(filters.since);
  }
  if (filters.until) {
    where.push(`received_at <= ?`);
    params.push(filters.until);
  }
  if (filters.hasAttachment) {
    where.push(`attachments IS NOT NULL AND attachments != '[]'`);
  }
  if (!filters.includeArchived) {
    where.push(`archived_at IS NULL`);
  }

  if (filters.keyword) {
    const kw = '%' + filters.keyword.toLowerCase() + '%';
    const field = filters.field || 'all';
    const fieldMap = {
      subject: () => { where.push(`LOWER(subject) LIKE ?`); params.push(kw); },
      body: () => { where.push(`(LOWER(text_body) LIKE ? OR LOWER(html_body) LIKE ?)`); params.push(kw, kw); },
      from: () => { where.push(`LOWER(from_addr) LIKE ?`); params.push(kw); },
      to: () => { where.push(`LOWER(to_addr) LIKE ?`); params.push(kw); },
      all: () => {
        where.push(`(LOWER(subject) LIKE ? OR LOWER(text_body) LIKE ? OR LOWER(html_body) LIKE ? OR LOWER(from_addr) LIKE ? OR LOWER(to_addr) LIKE ?)`);
        params.push(kw, kw, kw, kw, kw);
      },
    };
    (fieldMap[field] || fieldMap.all)();
  }

  const limit = Math.min(Number(filters.limit) || 20, MAX_QUERY_LIMIT);
  const sql = `SELECT * FROM emails
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY received_at DESC LIMIT ?`;
  params.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results.map(toRecord);
}

export {
  ensureSchema,
  insertEmail,
  setAgentSummary,
  setRead,
  setStarred,
  setArchived,
  listRecent,
  getById,
  queryEmails,
};
