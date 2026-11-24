import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

// Safe outbound HTTP (003 research R11, moved here for feature 006, T013): HTTPS to public addresses
// only. Names are checked when they resolve (the connection uses the checked address, so there is
// no DNS-rebinding gap), and address literals before connecting. No redirects are followed, the
// whole request has a timeout, and the answer has a size cap. Node's own clients are used, so the
// API needs no HTTP library. `allowLocal` (OUTBOUND_ALLOW_LOCAL, refused in production by the
// config and ignored here when NODE_ENV is production) lets local runs and tests reach
// http://localhost, and nothing else private.

export type SafeHttpFailure = 'BAD_URL' | 'NOT_HTTPS' | 'BLOCKED_ADDRESS' | 'REDIRECT' | 'TIMEOUT' | 'TOO_LARGE' | 'NETWORK';

export class SafeHttpError extends Error {
  constructor(
    readonly reason: SafeHttpFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SafeHttpError';
  }
}

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

/** True for any address an outbound request may not reach; anything that is not an IP address is refused too. */
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

export type Resolver = (hostname: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
type LookupCallback = (error: Error | null, address: string | LookupAddress[], family?: number) => void;

const defaultResolver: Resolver = (host, options, callback) => dnsLookup(host, options, callback);
const blockedError = () => new SafeHttpError('BLOCKED_ADDRESS', 'This address is private or reserved, so it cannot be called');

/** A `lookup` for http(s).request that refuses a name when any address it resolves to is not public. */
export function createSafeLookup(resolve: Resolver = defaultResolver, makeBlockedError: () => Error = blockedError) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) return callback(makeBlockedError(), '');
      if (options.all) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first!.address, first!.family);
    });
  };
}

const safeLookup = createSafeLookup();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** True when the local-test allowance applies to this host (never in production). */
function localAllowed(host: string, allowLocal: boolean | undefined): boolean {
  return Boolean(allowLocal) && process.env.NODE_ENV !== 'production' && LOCAL_HOSTS.has(host);
}

export interface SafeRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Answers larger than this fail with TOO_LARGE (default 100 KB). */
  maxBytes?: number;
  /** OUTBOUND_ALLOW_LOCAL: lets http(s)://localhost through outside production. */
  allowLocal?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  durationMs: number;
}

export const DEFAULT_MAX_BYTES = 100 * 1024;

/** One request; throws SafeHttpError when it is refused or fails, and returns any HTTP status otherwise. */
export function safeRequest(input: SafeRequest): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return Promise.reject(new SafeHttpError('BAD_URL', 'The address is not a valid URL'));
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = localAllowed(host, input.allowLocal);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return Promise.reject(new SafeHttpError('NOT_HTTPS', 'Only https:// addresses can be called'));
  }
  if (!local && ((isIP(host) && isBlockedAddress(host)) || host === 'localhost' || host.endsWith('.localhost'))) return Promise.reject(blockedError());

  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const started = Date.now();
  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: SafeHttpError | null, response?: SafeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const headers: Record<string, string | number> = { ...(input.headers ?? {}) };
    if (input.body !== undefined) headers['content-length'] = Buffer.byteLength(input.body);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: input.method, headers, ...(local ? {} : { lookup: safeLookup }) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        finish(new SafeHttpError('REDIRECT', `The address answered with a redirect (${status}), which is not followed`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          finish(new SafeHttpError('TOO_LARGE', `The answer is larger than ${Math.round(maxBytes / 1024)} KB`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => finish(new SafeHttpError('NETWORK', error.message)));
      res.on('end', () => finish(null, { status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), durationMs: Date.now() - started }));
    });
    const timer = setTimeout(() => {
      finish(new SafeHttpError('TIMEOUT', `No answer within ${Math.round(input.timeoutMs / 100) / 10} s`));
      req.destroy();
    }, input.timeoutMs);
    req.on('error', (error) => finish(error instanceof SafeHttpError ? error : new SafeHttpError('NETWORK', error.message)));
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}
