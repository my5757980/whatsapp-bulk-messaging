// Feature 010 (T002, contracts/meta-business-profile.md): the WhatsApp Business profile and the number status
// fields, held in memory per number, with Meta-style errors beyond Meta's limits.
//   GET  /{ver}/{phone-number-id}/whatsapp_business_profile?fields=...
//   POST /{ver}/{phone-number-id}/whatsapp_business_profile      (profile_picture_handle sets a picture URL)
//   GET  /{ver}/{phone-number-id}?fields=...name_status...        (verified_name, name_status, new_name_status,
//                                                                  quality_rating, the portfolio messaging limit)
//   POST /mock/name-status { phoneNumberId, nameStatus, newNameStatus }   test helper, no Graph equivalent
import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from './env.js';

interface Profile {
  about: string;
  address?: string;
  description?: string;
  email?: string;
  websites: string[];
  vertical?: string;
  profile_picture_url?: string;
}

interface Status {
  nameStatus: string;
  newNameStatus?: string;
}

const profiles = new Map<string, Profile>();
const statuses = new Map<string, Status>();
let pictures = 0;

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function graphError(res: ServerResponse, message: string): true {
  return send(res, 400, { error: { message, type: 'OAuthException', code: 100, error_user_msg: message, fbtrace_id: 'MOCKPROFILE' } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const profileOf = (id: string): Profile => {
  const existing = profiles.get(id);
  if (existing) return existing;
  const created: Profile = { about: 'Hey there! I am using WhatsApp.', websites: [] };
  profiles.set(id, created);
  return created;
};

/** Meta's documented limits (the platform checks them first, so these only show when it does not). */
function problem(body: Record<string, unknown>): string | null {
  if (typeof body.about === 'string' && (body.about.length < 1 || body.about.length > 139)) return 'Param about must be between 1 and 139 characters long';
  if (typeof body.address === 'string' && body.address.length > 256) return 'Param address must be at most 256 characters long';
  if (typeof body.description === 'string' && body.description.length > 512) return 'Param description must be at most 512 characters long';
  if (typeof body.email === 'string' && body.email.length > 128) return 'Param email must be at most 128 characters long';
  if (Array.isArray(body.websites) && body.websites.length > 2) return 'Param websites must have at most 2 entries';
  return null;
}

export async function handleBusinessProfile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/mock/name-status') {
    const body = (await readJson(req)) as { phoneNumberId?: string; nameStatus?: string; newNameStatus?: string };
    if (!body.phoneNumberId || !body.nameStatus) return send(res, 400, { error: 'phoneNumberId and nameStatus are required' });
    statuses.set(body.phoneNumberId, { nameStatus: body.nameStatus, ...(body.newNameStatus ? { newNameStatus: body.newNameStatus } : {}) });
    return send(res, 200, { ok: true });
  }

  const [version, id, resource] = url.pathname.split('/').filter(Boolean);
  if (!version?.startsWith('v') || !id) return false;
  const isProfile = resource === 'whatsapp_business_profile';
  const isStatus = req.method === 'GET' && !resource && (url.searchParams.get('fields') ?? '').includes('name_status');
  if (!isProfile && !isStatus) return false;
  if (req.headers.authorization !== `Bearer ${env.token}`) return send(res, 401, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } });

  if (isStatus) {
    const status = statuses.get(id) ?? { nameStatus: 'APPROVED' };
    return send(res, 200, {
      id,
      verified_name: 'Mock Business',
      name_status: status.nameStatus,
      ...(status.newNameStatus ? { new_name_status: status.newNameStatus } : {}),
      quality_rating: 'GREEN',
      whatsapp_business_manager_messaging_limit: 'TIER_2K',
    });
  }
  if (req.method === 'GET') return send(res, 200, { data: [{ ...profileOf(id), messaging_product: 'whatsapp' }] });
  if (req.method !== 'POST') return false;
  const body = await readJson(req);
  if (body.messaging_product !== 'whatsapp') return graphError(res, 'Param messaging_product must be whatsapp');
  const wrong = problem(body);
  if (wrong) return graphError(res, wrong);
  const { messaging_product: _product, profile_picture_handle: handle, ...fields } = body;
  const profile = profileOf(id);
  Object.assign(profile, fields);
  if (typeof handle === 'string') profile.profile_picture_url = `http://localhost:${env.port}/mock/profile-picture/${++pictures}.jpg`;
  return send(res, 200, { success: true });
}
