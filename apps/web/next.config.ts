import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// One .env at the repo root serves every app (see .env.example). Variables already set win.
const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // Strict nonce-based CSP lands with the first PHI screens (docs/11-security-hipaa.md); this blocks framing and plugins now.
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  },
];

const config: NextConfig = {
  poweredByHeader: false,
  // Do not write AGENTS.md into the app; repo guidance lives in CLAUDE.md.
  agentRules: false,
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: [
    '@cleanpost/adapters',
    '@cleanpost/auth',
    '@cleanpost/claims',
    '@cleanpost/clock',
    '@cleanpost/config',
    '@cleanpost/db',
    '@cleanpost/domain',
    '@cleanpost/eligibility',
    '@cleanpost/email',
    '@cleanpost/jobs',
    '@cleanpost/log',
    '@cleanpost/remit',
    '@cleanpost/reports',
    '@cleanpost/sync',
    '@cleanpost/ui',
    '@cleanpost/work',
    '@cleanpost/x12',
  ],
  // 835 uploads (R-02) go through a server action; a month of payments for one payer fits easily.
  experimental: { serverActions: { bodySizeLimit: '10mb' } },
  serverExternalPackages: ['pg', 'pg-boss', 'pino', 'nodemailer'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
