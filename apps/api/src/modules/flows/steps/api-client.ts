import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

// The HTTP client of API steps and test requests (003 T057, research R11, FR-014). Only HTTPS to
// public addresses: names are checked when they resolve (the connection uses the checked address,
// so there is no DNS-rebinding gap) and address literals before connecting. No redirects, a total
// timeout, a 100 KB reply cap, and JSON replies for mapping. Node's own https client is used, with a
// lookup that refuses non-public addresses, so the API needs no extra HTTP library.

export const RESPONSE_LIMIT_BYTES = 100 * 1024;

export type ApiCallFailure = 'BAD_URL' | 'NOT_HTTPS' | 'BLOCKED_ADDRESS' | 'REDIRECT' | 'TIMEOUT' | 'TOO_LARGE' | 'NOT_JSON' | 'NETWORK';

export class ApiCallError extends Error {
  constructor(
    readonly reason: ApiCallFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

const blocked = () => new ApiCallError('BLOCKED_ADDRESS', 'This address is private or reserved, so a flow cannot call it');

/**
 * Private, loopback, link-local, shared, documentation, multicast and reserved ranges, in two lists:
 * Node also checks IPv4 addresses against IPv4-mapped IPv6 rules, so one list holding ::ffff:0:0/96
 * would block every IPv4 address. IPv4 inside IPv6 is handled in isBlockedAddress instead.
 */
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail is allowed); null when malformed. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? null : rest ? rest.split(':') : [];
  const groups = right === null ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.length === 8 ? groups.map((g) => parseInt(g || '0', 16)) : null;
}

/** True for any address an API step may not reach; anything that is not an IP address is refused too. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (family !== 6) return true;
  const g = ipv6Groups(address);
  if (!g) return true;
  // IPv4 inside IPv6 (::ffff:a.b.c.d, also written in hex) is judged as the IPv4 address it is.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return BLOCKED_V4.check(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`, 'ipv4');
  }
  return BLOCKED_V6.check(address, 'ipv6');
}

type Resolver = (hostname: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
type LookupCallback = (error: Error | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for https.request that refuses a name when any address it resolves to is not public. */
export function createSafeLookup(resolve: Resolver = (host, options, callback) => dnsLookup(host, options, callback)) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) return callback(blocked(), '');
      if (options.all) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first!.address, first!.family);
    });
  };
}

const safeLookup = createSafeLookup();

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface ApiResponse {
  status: number;
  /** Parsed JSON for 2xx replies (null when empty); null for other statuses. */
  body: unknown;
  /** The reply text, for the editor's test request. */
  text: string;
}

/** Makes one call; throws ApiCallError for refused or failed calls, returns the status otherwise. */
export function callApi(input: ApiRequest): Promise<ApiResponse> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return Promise.reject(new ApiCallError('BAD_URL', 'The address is not a valid URL'));
  }
  if (url.protocol !== 'https:') return Promise.reject(new ApiCallError('NOT_HTTPS', 'Only https:// addresses can be called'));
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((isIP(host) && isBlockedAddress(host)) || host === 'localhost' || host.endsWith('.localhost')) return Promise.reject(blocked());

  return new Promise<ApiResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: ApiCallError | null, response?: ApiResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const headers: Record<string, string | number> = { accept: 'application/json', ...input.headers };
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(input.body);
    }
    const req = request(url, { method: input.method, headers, lookup: safeLookup }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        finish(new ApiCallError('REDIRECT', `The address answered with a redirect (${status}), which flows do not follow`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT_BYTES) {
          finish(new ApiCallError('TOO_LARGE', 'The reply is larger than 100 KB'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => finish(new ApiCallError('NETWORK', error.message)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) return finish(null, { status, body: null, text });
        if (!text.trim()) return finish(null, { status, body: null, text });
        try {
          finish(null, { status, body: JSON.parse(text) as unknown, text });
        } catch {
          finish(new ApiCallError('NOT_JSON', 'The reply is not JSON'));
        }
      });
    });
    const timer = setTimeout(() => {
      finish(new ApiCallError('TIMEOUT', `No reply within ${Math.round(input.timeoutMs / 100) / 10} s`));
      req.destroy();
    }, input.timeoutMs);
    req.on('error', (error) => finish(error instanceof ApiCallError ? error : new ApiCallError('NETWORK', error.message)));
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}

/** A value at a dotted path (`order.status`, `items.0.name`); undefined when the path is not there. */
export function pickPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Reply fields as answers: text (up to 1000 characters), numbers, and true/false as text. */
export function mapFields(body: unknown, map: Array<{ path: string; answerName: string }>): Record<string, string | number> {
  const answers: Record<string, string | number> = {};
  for (const { path, answerName } of map) {
    const value = pickPath(body, path);
    if (typeof value === 'string') answers[answerName] = value.slice(0, 1000);
    else if (typeof value === 'number' && Number.isFinite(value)) answers[answerName] = value;
    else if (typeof value === 'boolean') answers[answerName] = String(value);
  }
  return answers;
}
