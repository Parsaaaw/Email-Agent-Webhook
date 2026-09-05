import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as db from './db.js';

// Deployed as its own Durable-Object-backed Worker endpoint at /mcp
// (Streamable HTTP transport). Connect from Claude Code with:
//   claude mcp add --transport http email-agent https://<your-worker>.workers.dev/mcp
// No local process, no npm install, no RAILWAY_BASE_URL — it talks to D1 directly.
export class EmailMcp extends McpAgent {
  server = new McpServer({ name: 'email-agent-mcp', version: '2.0.0' });

  async init() {
    const env = this.env;

    this.server.tool(
      'list_recent_emails',
      'List the most recently received emails (newest first).',
      { limit: z.number().int().min(1).max(50).optional().describe('How many emails to return (default 20)') },
      async ({ limit }) => {
        const emails = await db.listRecent(env, limit || 20);
        return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
      }
    );

    this.server.tool(
      'get_email',
      'Get the full content (including body) of a single email by id.',
      { id: z.string().describe('The email id, from list_recent_emails') },
      async ({ id }) => {
        const email = await db.getById(env, id);
        if (!email) return { content: [{ type: 'text', text: `No email found with id ${id}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(email, null, 2) }] };
      }
    );

    this.server.tool(
      'list_emails_by_domain',
      'List emails received from a given sender domain (e.g. "github.com").',
      {
        domain: z.string().describe('Sender domain, without the @, e.g. "github.com"'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async ({ domain, limit }) => {
        const emails = await db.queryEmails(env, { domain, limit: limit || 20 });
        return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
      }
    );

    this.server.tool(
      'search_emails',
      'Search emails by keyword, optionally restricted to one field.',
      {
        query: z.string().describe('Keyword to search for'),
        field: z.enum(['subject', 'body', 'from', 'to', 'all']).optional().describe('Which field to search (default: all)'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async ({ query, field, limit }) => {
        const emails = await db.queryEmails(env, { keyword: query, field, limit: limit || 20 });
        return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
      }
    );

    this.server.tool(
      'list_emails_in_range',
      'List emails received within a date/time range (ISO 8601 timestamps).',
      {
        from_date: z.string().describe('Start of range, ISO 8601, e.g. "2026-08-01T00:00:00Z"'),
        to_date: z.string().describe('End of range, ISO 8601, e.g. "2026-08-18T23:59:59Z"'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async ({ from_date, to_date, limit }) => {
        const emails = await db.queryEmails(env, { since: from_date, until: to_date, limit: limit || 20 });
        return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
      }
    );

    this.server.tool(
      'list_emails',
      'List/filter emails with any combination of filters: sender, domain, date range, keyword, attachments.',
      {
        sender: z.string().optional().describe('Substring to match in the from address'),
        domain: z.string().optional().describe('Sender domain, without the @'),
        from_date: z.string().optional().describe('Start of range, ISO 8601'),
        to_date: z.string().optional().describe('End of range, ISO 8601'),
        has_attachment: z.boolean().optional(),
        keyword: z.string().optional().describe('Keyword to search for'),
        field: z.enum(['subject', 'body', 'from', 'to', 'all']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async (args) => {
        const emails = await db.queryEmails(env, {
          sender: args.sender,
          domain: args.domain,
          since: args.from_date,
          until: args.to_date,
          hasAttachment: args.has_attachment,
          keyword: args.keyword,
          field: args.field,
          limit: args.limit || 20,
        });
        return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
      }
    );
  }
}
