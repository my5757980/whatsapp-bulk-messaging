import nock from 'nock';
import { META_BASE, META_VERSION } from './fixtures.js';

// Feature 010 (T073, contracts/meta-business-profile.md): a stateful Graph for the WhatsApp Business profile,
// the number status fields and the Resumable Upload steps, with Meta-style errors on demand. It answers only
// for the phone number ids it knows, so other fakes keep working.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface FakeNumberStatus {
  verified_name: string;
  name_status: string;
  new_name_status?: string;
  quality_rating: string;
  whatsapp_business_manager_messaging_limit?: string | { tier: string };
}

export class FakeBusinessGraph {
  readonly profiles = new Map<string, Json>();
  readonly statuses = new Map<string, FakeNumberStatus>();
  /** Every profile POST body, per number. */
  readonly posts: Array<{ phoneNumberId: string; body: Json }> = [];
  readonly uploads: string[] = [];
  /** How many Graph calls reached the fake (reads included). */
  calls = 0;
  /** The next profile POST fails with this Meta error. */
  failNextPost: { status: number; code: number; message: string } | null = null;
  private n = 0;

  /** A number Meta knows, with its profile and status. */
  number(phoneNumberId: string, profile: Json = {}, status: Partial<FakeNumberStatus> = {}): this {
    this.profiles.set(phoneNumberId, { about: 'Hello from Acme', websites: [], ...profile });
    this.statuses.set(phoneNumberId, { verified_name: 'Acme Store', name_status: 'APPROVED', quality_rating: 'GREEN', whatsapp_business_manager_messaging_limit: 'TIER_2K', ...status });
    return this;
  }

  install(): this {
    const v = `/${META_VERSION}/`;
    const ours = (p: string) => {
      if (!p.startsWith(v)) return false;
      const [id = '', edge] = p.slice(v.length).split('?')[0]!.split('/');
      return (this.profiles.has(id) && (edge === 'whatsapp_business_profile' || edge === undefined)) || edge === 'uploads' || id.startsWith('upload:');
    };
    for (const method of ['get', 'post'] as const) {
      nock(META_BASE).persist()[method](ours).query(true).reply(async (req: Request) => this.route(req));
    }
    return this;
  }

  private async route(req: Request): Promise<[number, unknown]> {
    this.calls++;
    const url = new URL(req.url);
    const [, id = '', edge] = url.pathname.split('/').filter(Boolean);
    const isJson = (req.headers.get('content-type') ?? '').includes('application/json');
    const body: Json = req.method === 'POST' && isJson ? ((await req.json()) as Json) : {};
    if (req.method === 'POST' && !isJson) await req.arrayBuffer();

    if (req.method === 'POST' && edge === 'uploads') return [200, { id: `upload:${++this.n}` }];
    if (req.method === 'POST' && id.startsWith('upload:')) {
      this.uploads.push(id);
      return [200, { h: `handle-${this.n}` }];
    }
    if (edge === 'whatsapp_business_profile') {
      const profile = this.profiles.get(id)!;
      if (req.method === 'GET') return [200, { data: [{ ...profile, messaging_product: 'whatsapp' }] }];
      this.posts.push({ phoneNumberId: id, body });
      if (this.failNextPost) {
        const f = this.failNextPost;
        this.failNextPost = null;
        return [f.status, { error: { message: f.message, type: 'OAuthException', code: f.code, error_user_msg: f.message, fbtrace_id: 'TRACE' } }];
      }
      const { messaging_product: _product, profile_picture_handle: handle, ...fields } = body;
      Object.assign(profile, fields);
      if (handle) profile.profile_picture_url = `https://pps.whatsapp.test/${String(handle)}.jpg`;
      return [200, { success: true }];
    }
    // GET /{phone-number-id}?fields=...: the number status.
    return [200, { id, ...this.statuses.get(id)! }];
  }
}
