// Fake Meta Graph API for local development and e2e tests (T063, constitution Principle V).
// Feature 002 (T003): free-form sends, read receipts and inbound media downloads
// (specs/002-team-inbox/contracts/meta-graph-inbox.md §2-§4 and §6).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { env } from './env.js';
import { postSigned, statusPayload, templateStatusPayload } from './webhook-emitter.js';

interface MockTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameter_format: string;
  components: unknown[];
}

interface SentMessage {
  wamid: string;
  phoneNumberId: string;
  to: string;
  /** Template name; empty for free-form messages. */
  template: string;
  /** template | text | image | video | audio | document */
  type: string;
  /** Text body or media caption of a free-form message. */
  text?: string;
  at: string;
}

interface StoredMedia {
  bytes: Buffer;
  mimeType: string;
  sha256: string;
}

/** Body of POST /{phone-number-id}/messages: a template, a free-form message or a read receipt. */
interface OutboundBody {
  to?: string;
  type?: string;
  status?: string;
  message_id?: string;
  template?: { name?: string };
  text?: { body?: string };
  [mediaType: string]: unknown;
}

const templates = new Map<string, MockTemplate[]>(); // wabaId -> templates
const sent: SentMessage[] = [];
const reads: Array<{ phoneNumberId: string; messageId: string; at: string }> = [];
/** Customer media posted by the inbound CLI, served back through GET /{media-id} like Meta does. */
const media = new Map<string, StoredMedia>();

const MEDIA_TYPES: readonly string[] = ['image', 'video', 'audio', 'document'];

/** Returns a Graph-style error message when a send body is not one Meta would accept. */
function outboundProblem(type: string | undefined, body: OutboundBody): string | undefined {
  if (type === 'template') return body.template?.name ? undefined : 'Missing template name';
  if (type === 'text') {
    const text = body.text?.body;
    if (typeof text !== 'string' || text.trim() === '') return "Param text['body'] is required";
    return text.length > 4096 ? "Param text['body'] must be at most 4096 characters" : undefined;
  }
  if (type && MEDIA_TYPES.includes(type)) {
    const object = body[type] as { id?: string; link?: string; caption?: string } | undefined;
    if (!object?.id && !object?.link) return `Param ${type}['id'] or ${type}['link'] is required`;
    if (type === 'audio' && object.caption !== undefined) return "Param audio['caption'] is not allowed";
    return undefined;
  }
  return `Unsupported message type: ${type ?? '(none)'}`;
}

/** Category of a template by name (Meta's pricing category follows the template category). */
const templateCategory = (name: string): string | undefined => [...templates.values()].flat().find((t) => t.name === name)?.category;
let counter = 0;
const nextId = (prefix: string) => `${prefix}${Date.now()}${(counter++).toString().padStart(4, '0')}`;

function seedTemplates(wabaId: string): MockTemplate[] {
  let list = templates.get(wabaId);
  if (!list) {
    list = [
      {
        id: nextId('T'),
        name: 'order_confirmation',
        language: 'en_US',
        category: 'UTILITY',
        status: 'APPROVED',
        parameter_format: 'POSITIONAL',
        components: [
          { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is confirmed.', example: { body_text: [['Sara', '#10234']] } },
        ],
      },
      {
        id: nextId('T'),
        name: 'summer_sale',
        language: 'en_US',
        category: 'MARKETING',
        status: 'APPROVED',
        parameter_format: 'POSITIONAL',
        components: [
          { type: 'BODY', text: 'Hello {{1}}! Our summer sale starts today.', example: { body_text: [['Sara']] } },
          { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/{{1}}', example: ['summer'] }] },
        ],
      },
    ];
    templates.set(wabaId, list);
  }
  return list;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function graphError(res: ServerResponse, status: number, code: number, message: string): void {
  send(res, status, { error: { message, type: 'OAuthException', code, fbtrace_id: nextId('trace') } });
}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBytes(req)).toString('utf8');
}

const later = (ms: number, fn: () => Promise<unknown>) => setTimeout(() => void fn(), ms);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${env.port}`);
  const [version, id, resource] = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'GET' && url.pathname === '/mock/sent') return send(res, 200, { count: sent.length, messages: sent });
  if (req.method === 'GET' && url.pathname === '/mock/reads') return send(res, 200, { count: reads.length, reads });

  // Graph accepts "Bearer <token>"; the resumable upload data call uses "OAuth <token>".
  const auth = req.headers.authorization ?? '';
  const authorized = auth === `Bearer ${env.token}` || auth === `OAuth ${env.token}`;

  // Test helper with no Graph equivalent: the inbound CLI stores customer media here first.
  if (req.method === 'POST' && url.pathname === '/mock/media') {
    const bytes = await readBytes(req);
    const mediaId = nextId('inmedia');
    media.set(mediaId, {
      bytes,
      mimeType: url.searchParams.get('mime_type') ?? 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return send(res, 200, { id: mediaId });
  }
  // The short-lived download URL handed out by GET /{media-id}; Meta requires the same token here.
  const download = /^\/mock\/media\/([^/]+)\/download$/.exec(url.pathname);
  if (req.method === 'GET' && download) {
    if (!authorized) return graphError(res, 401, 190, 'Invalid OAuth access token');
    const item = media.get(download[1] ?? '');
    if (!item) return graphError(res, 404, 100, 'Unknown media');
    res.writeHead(200, { 'content-type': item.mimeType, 'content-length': item.bytes.length });
    res.end(item.bytes);
    return;
  }

  if (!version?.startsWith('v') || !id) return graphError(res, 404, 100, 'Unknown path');
  if (!authorized) return graphError(res, 401, 190, 'Invalid OAuth access token');

  // Resumable Upload API (template header samples): POST /{ver}/{appId}/uploads -> { id: "upload:..." }
  if (req.method === 'POST' && resource === 'uploads') {
    if (!url.searchParams.get('file_length') || !url.searchParams.get('file_type')) return graphError(res, 400, 100, 'Missing file_length or file_type');
    return send(res, 200, { id: `upload:${nextId('S')}` });
  }
  // POST /{ver}/upload:<session> with the file bytes and file_offset: 0 -> { h: "<handle>" }
  if (req.method === 'POST' && id.startsWith('upload:') && !resource) {
    await readBody(req);
    if (req.headers.file_offset !== '0') return graphError(res, 400, 100, 'file_offset header is required');
    return send(res, 200, { h: `4::${Buffer.from(nextId('H')).toString('base64')}` });
  }

  // GET /{ver}/{mediaId}: metadata and a download URL for media a customer sent (§3)
  const stored = req.method === 'GET' && !resource ? media.get(id) : undefined;
  if (stored) {
    return send(res, 200, {
      messaging_product: 'whatsapp',
      url: `http://${req.headers.host ?? `localhost:${env.port}`}/mock/media/${id}/download`,
      mime_type: stored.mimeType,
      sha256: stored.sha256,
      file_size: stored.bytes.length,
      id,
    });
  }

  // GET /{ver}/{phoneNumberId}
  if (req.method === 'GET' && !resource) {
    return send(res, 200, {
      id,
      display_phone_number: '+1 555 010 0000',
      verified_name: 'Mock Business',
      quality_rating: 'GREEN',
      code_verification_status: 'VERIFIED',
      status: 'CONNECTED',
      throughput: { level: 'STANDARD' },
    });
  }

  // POST /{ver}/{phoneNumberId}/messages: templates, free-form messages (§2) and read receipts (§4)
  if (req.method === 'POST' && resource === 'messages') {
    const body = JSON.parse((await readBody(req)) || '{}') as OutboundBody;
    if (body.status === 'read') {
      if (!body.message_id) return graphError(res, 400, 100, 'Missing message_id');
      reads.push({ phoneNumberId: id, messageId: body.message_id, at: new Date().toISOString() });
      return send(res, 200, { success: true });
    }
    const to = body.to;
    if (!to) return graphError(res, 400, 100, 'Missing to');
    const type = body.type ?? (body.template ? 'template' : undefined);
    const problem = outboundProblem(type, body);
    if (problem || !type) return graphError(res, 400, 100, problem ?? 'Missing type');

    const wamid = `wamid.${nextId('M')}`;
    const templateName = type === 'template' ? (body.template?.name ?? '') : '';
    const caption = (body[type] as { caption?: string } | undefined)?.caption;
    sent.push({ wamid, phoneNumberId: id, to, template: templateName, type, text: type === 'text' ? body.text?.body : caption, at: new Date().toISOString() });

    const wabaId = 'MOCK_WABA';
    const failWith = (code: number, title: string, message: string) =>
      later(500, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'failed', error: { code, title, message } })));
    if (to.endsWith('0000')) {
      failWith(131026, 'Message undeliverable', 'Message undeliverable');
    } else if (type !== 'template' && to.endsWith('0047')) {
      // A free-form message outside the 24-hour window fails asynchronously with 131047.
      failWith(131047, 'Re-engagement message', 'More than 24 hours have passed since the recipient last replied to the sender number.');
    } else {
      // Free-form replies are service conversations; templates are priced by their category.
      const category = type === 'template' ? templateCategory(templateName) : 'service';
      later(400, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'sent', category })));
      later(900, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'delivered', category })));
      later(1600, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'read', category })));
    }
    return send(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: wamid }] });
  }

  // POST /{ver}/{phoneNumberId}/media
  if (req.method === 'POST' && resource === 'media') {
    await readBody(req);
    return send(res, 200, { id: nextId('media') });
  }

  // /{ver}/{wabaId}/message_templates
  if (resource === 'message_templates') {
    const list = seedTemplates(id);
    if (req.method === 'GET') return send(res, 200, { data: list, paging: { cursors: { before: 'B', after: 'A' } } });
    if (req.method === 'DELETE') {
      const name = url.searchParams.get('name');
      const hsmId = url.searchParams.get('hsm_id');
      // With hsm_id only that language version is deleted; by name alone every language goes.
      templates.set(id, list.filter((t) => (hsmId ? t.id !== hsmId : t.name !== name)));
      return send(res, 200, { success: true });
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as Partial<MockTemplate>;
      if (!body.name || !/^[a-z0-9_]+$/.test(body.name)) return graphError(res, 400, 100, 'Invalid template name');
      const template: MockTemplate = {
        id: nextId('T'),
        name: body.name,
        language: body.language ?? 'en_US',
        category: body.category ?? 'MARKETING',
        status: 'PENDING',
        parameter_format: body.parameter_format ?? 'POSITIONAL',
        components: body.components ?? [],
      };
      list.push(template);
      later(env.templateApprovalMs, async () => {
        template.status = 'APPROVED';
        await postSigned(templateStatusPayload({ wabaId: id, id: template.id, name: template.name, language: template.language, event: 'APPROVED' }));
      });
      return send(res, 200, { id: template.id, status: 'PENDING', category: template.category });
    }
  }

  return graphError(res, 404, 100, `Unsupported ${req.method} ${url.pathname}`);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => graphError(res, 500, 1, error instanceof Error ? error.message : 'mock error'));
});

server.listen(env.port, () => console.log(`mock-meta listening on http://localhost:${env.port}`));
