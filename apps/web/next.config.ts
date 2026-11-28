import path from 'node:path';
import type { NextConfig } from 'next';

// The browser talks only to this Next.js origin; /api/* is proxied to the NestJS API so the
// session and CSRF cookies stay first-party (ADR-0005). With standalone output the rewrite target
// is fixed at build time, so container builds pass API_INTERNAL_URL as a build argument.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/**
 * Security headers for every page (T198). Without per-request nonces Next.js needs inline
 * scripts, so script-src keeps 'unsafe-inline'; everything else is limited to this origin.
 */
export function securityHeaders(isDev: boolean): Array<{ key: string; value: string }> {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
  ];
}

const nextConfig: NextConfig = {
  output: 'standalone',
  // Trace from the monorepo root so the standalone server includes hoisted workspace packages.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    // /api/* responses come from the API, which sends its own stricter headers (helmet).
    return [{ source: '/((?!api/).*)', headers: securityHeaders(process.env.NODE_ENV !== 'production') }];
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` },
      // Feature 009: the website button script, for the designer's preview (the CSP allows only this origin).
      { source: '/w/widget.js', destination: `${apiInternalUrl}/l/w/widget.js` },
    ];
  },
};

export default nextConfig;
