// Fake Meta Graph API for local development and e2e tests (T063, constitution Principle V).
// Feature 002 (T003): free-form sends, read receipts and inbound media downloads
// (specs/002-team-inbox/contracts/meta-graph-inbox.md §2-§4 and §6).
// Feature 004 (T006): a fake Claude Messages endpoint under /anthropic (src/ai.ts).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { aiRequests, answerMessages, resetAi, setAiRules, streamEvents } from './ai.js';
import { answerFor, catchName, clear as clearCaught, list as listCaught, record as recordCaught, setAnswer as setCatchAnswer } from './catch.js';
import { env } from './env.js';
import { handleShopify } from './shopify.js';
import { handleWoo } from './woocommerce.js';
import { handleWizard } from './wizard.js';
import { handleBusinessProfile } from './business-profile.js';
import { handleAds } from './ads.js';
import { commerceInteractiveProblem, handleCommerce } from './commerce.js';
import { handleStripe } from './stripe.js';
import { handleTemplatesMock, isDeliveryHeld, storedComponents, templateCreateProblem, templateSendProblem } from './templates.js';
import { postSigned, statusPayload, templateStatusPayload } from './webhook-emitter.js';

interface MockTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameter_format: string;
  components: unknown[];
  /** Feature 009: the template's time-to-live, as sent. */
  message_send_ttl_seconds?: number;
}

interface SentMessage {
  wamid: string;
  phoneNumberId: string;
  to: string;
  /** Template name; empty for free-form messages. */
  template: string;
  /** Template parameters as sent, so tests can read per-recipient values such as tracked-link codes (005). */
  components?: unknown[];
  /** template | text | image | video | audio | document */
  type: string;
  /** Text body or media caption of a free-form message (body text for interactive messages). */
  text?: string;
  /** Reply buttons or list rows of an interactive message, so tests can tap them (feature 003). */
  options?: Array<{ id: string; title: string }>;
  /** The interactive object as sent, so tests can read cta_url links and flow tokens (feature 008). */
  interactive?: unknown;
  at: string;
}

/** The interactive object of a buttons or list message (003 contracts/meta-graph-flows.md). */
interface InteractiveBody {
  type?: string;
  header?: { type?: string; text?: string };
  body?: { text?: string };
  footer?: { text?: string };
  action?: {
    buttons?: Array<{ type?: string; reply?: { id?: string; title?: string } }>;
    button?: string;
    sections?: Array<{ title?: string; rows?: Array<{ id?: string; title?: string; description?: string }> }>;
  };
}

const chars = (value: unknown): number => (typeof value === 'string' ? [...value].length : 0);
const within = (value: unknown, min: number, max: number): boolean => typeof value === 'string' && chars(value) >= min && chars(value) <= max;

/** Meta's limits for reply buttons and lists; returns the problem or undefined. */
function interactiveProblem(interactive: InteractiveBody | undefined): string | undefined {
  if (!interactive) return "Param interactive is required";
  // Feature 008: product, product_list, catalog_message, cta_url and flow messages (src/commerce.ts).
  const commerce = commerceInteractiveProblem(interactive);
  if (commerce !== null) return commerce;
  if (!within(interactive.body?.text, 1, 1024)) return "Param interactive['body']['text'] must have 1 to 1024 characters";
  if (interactive.header !== undefined && !within(interactive.header.text, 1, 60)) return "Param interactive['header']['text'] must have 1 to 60 characters";
  if (interactive.footer !== undefined && !within(interactive.footer.text, 1, 60)) return "Param interactive['footer']['text'] must have 1 to 60 characters";
  if (interactive.type === 'button') {
    const buttons = interactive.action?.buttons ?? [];
    if (buttons.length < 1 || buttons.length > 3) return 'Interactive buttons need between 1 and 3 buttons';
    for (const button of buttons) {
      if (button.type !== 'reply') return "Button type must be 'reply'";
      if (!within(button.reply?.id, 1, 256)) return 'Button id must have 1 to 256 characters';
      if (!within(button.reply?.title, 1, 20)) return 'Button title must have 1 to 20 characters';
    }
    if (new Set(buttons.map((b) => b.reply?.id)).size !== buttons.length) return 'Button ids must be unique';
    if (new Set(buttons.map((b) => b.reply?.title)).size !== buttons.length) return 'Button titles must be unique';
    return undefined;
  }
  if (interactive.type === 'list') {
    if (!within(interactive.action?.button, 1, 20)) return "Param interactive['action']['button'] must have 1 to 20 characters";
    const sections = interactive.action?.sections ?? [];
    if (sections.length < 1 || sections.length > 10) return 'A list needs between 1 and 10 sections';
    const rows = sections.flatMap((section) => section.rows ?? []);
    if (rows.length < 1 || rows.length > 10) return 'A list needs between 1 and 10 rows in total';
    for (const section of sections) {
      if (section.title !== undefined && !within(section.title, 1, 24)) return 'Section title must have 1 to 24 characters';
      if (!section.rows?.length) return 'Each section needs at least one row';
    }
    for (const row of rows) {
      if (!within(row.id, 1, 200)) return 'Row id must have 1 to 200 characters';
      if (!within(row.title, 1, 24)) return 'Row title must have 1 to 24 characters';
      if (row.description !== undefined && !within(row.description, 0, 72)) return 'Row description must have at most 72 characters';
    }
    if (new Set(rows.map((r) => r.id)).size !== rows.length) return 'Row ids must be unique';
    return undefined;
  }
  return `Unsupported interactive type: ${interactive.type ?? '(none)'}`;
}

/** The buttons or rows of an interactive message, for /mock/sent. */
function interactiveOptions(interactive: InteractiveBody | undefined): Array<{ id: string; title: string }> {
  const buttons = (interactive?.action?.buttons ?? []).map((b) => ({ id: b.reply?.id ?? '', title: b.reply?.title ?? '' }));
  const rows = (interactive?.action?.sections ?? []).flatMap((s) => s.rows ?? []).map((r) => ({ id: r.id ?? '', title: r.title ?? '' }));
  return [...buttons, ...rows];
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
  template?: { name?: string; components?: unknown[] };
  text?: { body?: string };
  [mediaType: string]: unknown;
}

const templates = new Map<string, MockTemplate[]>(); // wabaId -> templates
const sent: SentMessage[] = [];
const reads: Array<{ phoneNumberId: string; messageId: string; at: string }> = [];
/** Numbers ending 1016 that already failed once; their later sends are delivered (005 retry rounds). */
const failedOnce = new Set<string>();
/** Customer media posted by the inbound CLI, served back through GET /{media-id} like Meta does. */
const media = new Map<string, StoredMedia>();

const MEDIA_TYPES: readonly string[] = ['image', 'video', 'audio', 'document'];

/** Returns a Graph-style error message when a send body is not one Meta would accept. */
function outboundProblem(type: string | undefined, body: OutboundBody): string | undefined {
  if (type === 'template') {
    if (!body.template?.name) return 'Missing template name';
    // Feature 009: authentication, carousel and offer sends follow Meta's rules (src/templates.ts).
    return templateSendProblem(templateByName(body.template.name), body.template.components) ?? undefined;
  }
  if (type === 'text') {
    const text = body.text?.body;
    if (typeof text !== 'string' || text.trim() === '') return "Param text['body'] is required";
    return text.length > 4096 ? "Param text['body'] must be at most 4096 characters" : undefined;
  }
  if (type === 'interactive') return interactiveProblem(body.interactive as InteractiveBody | undefined);
  if (type && MEDIA_TYPES.includes(type)) {
    const object = body[type] as { id?: string; link?: string; caption?: string } | undefined;
    if (!object?.id && !object?.link) return `Param ${type}['id'] or ${type}['link'] is required`;
    if (type === 'audio' && object.caption !== undefined) return "Param audio['caption'] is not allowed";
    return undefined;
  }
  return `Unsupported message type: ${type ?? '(none)'}`;
}

/** A stored template by name (feature 009 send checks). */
const templateByName = (name: string): MockTemplate | undefined => [...templates.values()].flat().find((t) => t.name === name);

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

  // Feature 009: held delivery and the test website (src/templates.ts).
  if (await handleTemplatesMock(req, res, url)) return;
  // Feature 008: the mock Stripe gateway and its hosted page (src/stripe.ts).
  if (await handleStripe(req, res, url)) return;
  // Feature 006: mock Shopify and WooCommerce stores (src/shopify.ts, src/woocommerce.ts).
  if (await handleShopify(req, res, url)) return;
  if (await handleWoo(req, res, url)) return;
  // Feature 007: the Marketing API routes for the ads tokens (src/ads.ts), before the wizard so its
  // debug_token answer does not take the ads tokens.
  if (await handleAds(req, res, url)) return;
  // Feature 006 US8: the number connection wizard's Graph routes, for the wizard tokens (src/wizard.ts).
  if (await handleWizard(req, res, url)) return;
  // Feature 008: catalog, commerce settings, items_batch and WhatsApp Flows (src/commerce.ts).
  if (await handleCommerce(req, res, url)) return;
  // Feature 010: the business profile and the number status fields (src/business-profile.ts).
  if (await handleBusinessProfile(req, res, url)) return;

  // Feature 006: the request catcher for outbound webhooks (src/catch.ts).
  const caughtAt = catchName(url.pathname);
  if (caughtAt) {
    if (caughtAt.action === 'answer' && req.method === 'POST') {
      const { status } = JSON.parse((await readBody(req)) || '{}') as { status?: number };
      setCatchAnswer(caughtAt.name, Number(status) || 200);
      return send(res, 200, { name: caughtAt.name, status: Number(status) || 200 });
    }
    if (caughtAt.action === 'record' && req.method === 'POST') {
      recordCaught(caughtAt.name, req.method, req.headers, await readBody(req));
      return send(res, answerFor(caughtAt.name, url.searchParams.get('status')), { received: true });
    }
    if (caughtAt.action === 'record' && req.method === 'GET') return send(res, 200, { name: caughtAt.name, requests: listCaught(caughtAt.name) });
    if (caughtAt.action === 'record' && req.method === 'DELETE') {
      clearCaught(caughtAt.name);
      return send(res, 200, { cleared: true });
    }
  }

  // Feature 004: the fake Claude endpoint (the SDK may add ?beta=true) and its test helpers.
  if (req.method === 'POST' && url.pathname === '/anthropic/v1/messages') {
    const answer = answerMessages(url.pathname + url.search, await readBody(req));
    if (answer.stream && answer.status === 200) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(streamEvents(answer.body as Parameters<typeof streamEvents>[0]));
      return;
    }
    return send(res, answer.status, answer.body);
  }
  if (req.method === 'POST' && url.pathname === '/mock/ai/rules') return send(res, 200, { rules: setAiRules(JSON.parse((await readBody(req)) || '[]')) });
  if (req.method === 'GET' && url.pathname === '/mock/ai/requests') return send(res, 200, aiRequests());
  if (req.method === 'DELETE' && url.pathname === '/mock/ai/requests') {
    resetAi();
    return send(res, 200, { cleared: true });
  }

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
    // Broken interactive limits answer 131009 ("Parameter value is not valid"), like Meta.
    if (problem || !type) return graphError(res, 400, type === 'interactive' ? 131009 : 100, problem ?? 'Missing type');

    const wamid = `wamid.${nextId('M')}`;
    const templateName = type === 'template' ? (body.template?.name ?? '') : '';
    const caption = (body[type] as { caption?: string } | undefined)?.caption;
    const interactive = type === 'interactive' ? (body.interactive as InteractiveBody) : undefined;
    sent.push({
      wamid,
      phoneNumberId: id,
      to,
      template: templateName,
      ...(type === 'template' && body.template?.components ? { components: body.template.components } : {}),
      type,
      text: type === 'text' ? body.text?.body : interactive ? interactive.body?.text : caption,
      ...(interactive ? { options: interactiveOptions(interactive), interactive } : {}),
      at: new Date().toISOString(),
    });

    const wabaId = 'MOCK_WABA';
    const failWith = (code: number, title: string, message: string) =>
      later(500, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'failed', error: { code, title, message } })));
    if (to.endsWith('0000')) {
      failWith(131026, 'Message undeliverable', 'Message undeliverable');
    } else if (type === 'template' && to.endsWith('1049')) {
      // Meta's per-person marketing limit (005): such messages are held back, never retried within 24 hours.
      failWith(131049, 'This message was not delivered to maintain healthy ecosystem engagement.', 'This message was not delivered to maintain healthy ecosystem engagement.');
    } else if (type === 'template' && to.endsWith('1016') && !failedOnce.has(`${id}:${to}`)) {
      // A failure that may pass (005 retry rounds): the first send fails with 131016, later sends are delivered.
      failedOnce.add(`${id}:${to}`);
      failWith(131016, 'Service unavailable', 'A service is temporarily unavailable.');
    } else if (type !== 'template' && to.endsWith('0047')) {
      // A free-form message outside the 24-hour window fails asynchronously with 131047.
      failWith(131047, 'Re-engagement message', 'More than 24 hours have passed since the recipient last replied to the sender number.');
    } else {
      // Free-form replies are service conversations; templates are priced by their category.
      const category = type === 'template' ? templateCategory(templateName) : 'service';
      later(400, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'sent', category })));
      // Feature 009: a held number gets no delivered or read status, so time-to-live can pass.
      if (!isDeliveryHeld(id)) {
        later(900, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'delivered', category })));
        later(1600, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: to, status: 'read', category })));
      }
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
      // Feature 009: the new kinds and the time-to-live follow Meta's rules (src/templates.ts).
      const kindProblem = templateCreateProblem(body);
      if (kindProblem) return graphError(res, 400, 100, kindProblem);
      const template: MockTemplate = {
        id: nextId('T'),
        name: body.name,
        language: body.language ?? 'en_US',
        category: body.category ?? 'MARKETING',
        status: 'PENDING',
        parameter_format: body.parameter_format ?? 'POSITIONAL',
        components: storedComponents(body.category, body.components ?? []),
        ...(typeof body.message_send_ttl_seconds === 'number' ? { message_send_ttl_seconds: body.message_send_ttl_seconds } : {}),
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
