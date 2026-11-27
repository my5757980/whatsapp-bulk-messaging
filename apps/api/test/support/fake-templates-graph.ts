import { metaCreateProblem, metaSendProblem, metaStoredComponents } from '@wbm/shared';
import nock from 'nock';
import { META_BASE, META_VERSION } from './fixtures.js';

// Feature 009 (T014, contracts/meta-templates.md §5): a stateful Graph for template create and edit,
// media uploads, resumable uploads and template sends, answering like Meta with the shared rules in
// @wbm/shared (meta-template-checks). Statuses are delivered by the tests (webhook.status), so a held
// delivery is simply a status that is never posted.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface FakeTemplate {
  id: string;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  components: unknown[];
  ttl?: number;
}

export interface FakeSend {
  phoneNumberId: string;
  to: string;
  body: Json;
  wamid: string;
}

export class FakeTemplatesGraph {
  readonly templates = new Map<string, FakeTemplate>();
  readonly creates: Json[] = [];
  readonly edits: Array<{ id: string; body: Json }> = [];
  readonly mediaUploads: Array<{ phoneNumberId: string; id: string }> = [];
  readonly resumableUploads: string[] = [];
  readonly sends: FakeSend[] = [];
  /** Numbers whose sends fail at once with this Meta error (e.g. 131026). */
  readonly failSends = new Map<string, { status: number; code: number; message: string }>();
  private n = 0;

  /** Registers a template Meta already has (seeded rows), so sends can be checked against it. */
  know(template: Omit<FakeTemplate, 'id'> & { id?: string }): FakeTemplate {
    const stored = { ...template, id: template.id ?? `T${++this.n}`, components: metaStoredComponents(template.category, template.components) };
    this.templates.set(stored.id, stored);
    return stored;
  }

  install(): this {
    const v = `/${META_VERSION}/`;
    const ours = (p: string) => {
      if (!p.startsWith(v)) return false;
      const [id = '', edge] = p.slice(v.length).split('?')[0]!.split('/');
      return edge === 'message_templates' || edge === 'media' || edge === 'messages' || edge === 'uploads' || id.startsWith('upload:') || (!edge && this.templates.has(id));
    };
    for (const method of ['get', 'post'] as const) {
      const scope = nock(META_BASE).persist();
      scope[method](ours)
        .query(true)
        .reply(async (req: Request) => this.route(req));
    }
    return this;
  }

  /** The sends to one recipient (digits, no plus). */
  sentTo(to: string): FakeSend[] {
    return this.sends.filter((s) => s.to === to.replace(/^\+/, ''));
  }

  private async route(req: Request): Promise<[number, unknown]> {
    const url = new URL(req.url);
    const [, id = '', edge] = url.pathname.split('/').filter(Boolean);
    const isJson = (req.headers.get('content-type') ?? '').includes('application/json');
    const body: Json = req.method !== 'GET' && isJson ? ((await req.json()) as Json) : {};
    if (req.method !== 'GET' && !isJson) await req.arrayBuffer();
    const error = (status: number, code: number, message: string): [number, unknown] => [status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'TRACE' } }];

    if (req.method === 'POST' && edge === 'uploads') {
      const session = `upload:S${++this.n}`;
      this.resumableUploads.push(session);
      return [200, { id: session }];
    }
    if (req.method === 'POST' && id.startsWith('upload:')) return [200, { h: `4::H${++this.n}` }];
    if (req.method === 'POST' && edge === 'media') {
      const media = { phoneNumberId: id, id: `media-${++this.n}` };
      this.mediaUploads.push(media);
      return [200, { id: media.id }];
    }
    if (edge === 'message_templates') {
      if (req.method === 'GET') return [200, { data: [...this.templates.values()].filter((t) => t.wabaId === id).map((t) => this.metaView(t)), paging: { cursors: {} } }];
      const problem = metaCreateProblem(body);
      if (problem) return error(400, 100, problem);
      this.creates.push(body);
      const template = this.know({ wabaId: id, name: String(body.name), language: String(body.language ?? 'en_US'), category: String(body.category ?? 'MARKETING'), components: body.components ?? [], ...(typeof body.message_send_ttl_seconds === 'number' ? { ttl: body.message_send_ttl_seconds } : {}) });
      return [200, { id: template.id, status: 'PENDING', category: template.category }];
    }
    if (req.method === 'POST' && !edge && this.templates.has(id)) {
      const template = this.templates.get(id)!;
      const problem = metaCreateProblem({ category: body.category ?? template.category, components: body.components ?? template.components, message_send_ttl_seconds: body.message_send_ttl_seconds });
      if (problem) return error(400, 100, problem);
      this.edits.push({ id, body });
      if (body.components) template.components = metaStoredComponents(template.category, body.components);
      if (typeof body.message_send_ttl_seconds === 'number') template.ttl = body.message_send_ttl_seconds;
      return [200, { success: true }];
    }
    if (req.method === 'GET' && !edge && this.templates.has(id)) return [200, this.metaView(this.templates.get(id)!)];
    if (req.method === 'POST' && edge === 'messages') {
      const failure = this.failSends.get(id);
      if (failure) return error(failure.status, failure.code, failure.message);
      if (body.type === 'template') {
        const template = [...this.templates.values()].find((t) => t.name === body.template?.name);
        const problem = template ? metaSendProblem(template, body.template?.components ?? []) : null;
        if (problem) return error(400, 132000, problem);
      }
      const wamid = `wamid.F${++this.n}`;
      this.sends.push({ phoneNumberId: id, to: String(body.to), body, wamid });
      return [200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: wamid }] }];
    }
    return error(404, 100, `FakeTemplatesGraph: unsupported ${req.method} ${url.pathname}`);
  }

  private metaView(t: FakeTemplate): Json {
    return { id: t.id, name: t.name, language: t.language, category: t.category, status: 'APPROVED', parameter_format: 'POSITIONAL', components: t.components, ...(t.ttl !== undefined ? { message_send_ttl_seconds: t.ttl } : {}) };
  }
}
