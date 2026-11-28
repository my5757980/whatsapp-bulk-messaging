// Feature 009 (T002, T003; specs/009-templates-growth/contracts/meta-templates.md §5): Meta's rules for
// authentication, carousel and limited-time offer templates and their sends, the time-to-live field,
// held delivery for time-to-live tests, and a test website page with the chat button snippet.
// The rules come from @wbm/shared (the workspace package, built before mock-meta runs in CI).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { metaCreateProblem, metaSendProblem, metaStoredComponents } from '@wbm/shared';

/** Numbers whose messages get a `sent` but no `delivered` webhook (time-to-live tests). */
const heldDelivery = new Set<string>();

export const isDeliveryHeld = (phoneNumberId: string): boolean => heldDelivery.has(phoneNumberId);

/** Problems with a template create body, as Meta reports them. */
export function templateCreateProblem(body: { category?: unknown; components?: unknown; message_send_ttl_seconds?: unknown }): string | null {
  return metaCreateProblem(body);
}

/** Components as Meta stores them (authentication OTP buttons become URL buttons). */
export function storedComponents(category: unknown, components: unknown): unknown[] {
  return metaStoredComponents(category, components);
}

/** Problems with a template send for the 009 kinds. */
export function templateSendProblem(template: { category: string; components: unknown[] } | undefined, components: unknown): string | null {
  return template ? metaSendProblem(template, components ?? []) : null;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * Handles the 009 control routes; returns true when it answered:
 * - POST /mock/hold-delivery { phoneNumberId, on }
 * - GET /mock/site/{page}?key=…: a plain page with the website chat button snippet
 * - GET or HEAD /mock/files/{name}.pdf: a small PDF, for campaign media addresses in e2e
 */
export async function handleTemplatesMock(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/mock/hold-delivery') {
    const body = await readJson(req);
    const id = String(body.phoneNumberId ?? '');
    if (!id) {
      send(res, 400, { error: 'phoneNumberId is required' });
      return true;
    }
    if (body.on === false) heldDelivery.delete(id);
    else heldDelivery.add(id);
    send(res, 200, { phoneNumberId: id, held: heldDelivery.has(id) });
    return true;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/mock\/files\/[\w.-]+\.pdf$/.test(url.pathname)) {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) });
    res.end(req.method === 'HEAD' ? undefined : pdf);
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/mock/site/')) {
    const key = url.searchParams.get('key') ?? '';
    const base = (process.env.PUBLIC_LINK_BASE_URL || 'http://localhost:4000/l').replace(/\/+$/, '');
    const page = escapeHtml(url.pathname.slice('/mock/site'.length) || '/');
    const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock shop ${page}</title></head>
<body>
<h1>Mock shop</h1>
<p>Page: <span data-testid="page">${page}</span></p>
${key ? `<script async src="${escapeHtml(base)}/w/widget.js" data-key="${escapeHtml(key)}"></script>` : '<p>Add ?key=&lt;button key&gt; to show the chat button.</p>'}
</body>
</html>`;
    send(res, 200, html, 'text/html; charset=utf-8');
    return true;
  }
  return false;
}
