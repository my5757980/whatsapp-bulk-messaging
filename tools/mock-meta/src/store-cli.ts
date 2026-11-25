import { env } from './env.js';

// `npm run mock:store -- <shopify|woo> <action> [--flags]` (feature 006 quickstart §2): drives the
// mock stores so they send signed webhooks to the platform.
//   shopify order --phone +971500000001 [--cod] [--total 120.00] [--times 2]
//   shopify fulfil --order 1001 [--tracking 1Z999]
//   shopify deliver --order 1001
//   shopify cancel --order 1001
//   shopify checkout --phone +971500000002 [--value 249.00]
//   woo order --phone +971500000003 [--status pending] [--cod]
//   woo status --order 700 --status completed
// --shop (Shopify) or --site (WooCommerce) picks the store, "demo" by default: connect it in the
// dashboard as http://localhost:4010/shopify/demo or http://localhost:4010/woo/demo.

function flags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) out[arg.slice(2)] = true;
    else {
      out[arg.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [platform, action, ...rest] = process.argv.slice(2);
  if ((platform !== 'shopify' && platform !== 'woo') || !action) {
    console.error('usage: npm run mock:store -- <shopify|woo> <action> [--flags]');
    process.exit(2);
  }
  const f = flags(rest);
  const store = String(f.shop ?? f.site ?? 'demo');
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) if (key !== 'shop' && key !== 'site') body[key] = value;
  const res = await fetch(`${env.baseUrl}/mock/${platform}/${store}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(res.status, await res.text());
  if (!res.ok) process.exit(1);
}

void main();
