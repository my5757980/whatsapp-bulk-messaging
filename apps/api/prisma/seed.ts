import '../src/common/config/load-env.js';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Seeds default settings and (optionally) the first admin (T027).
 *   npm run db:seed -- --admin-email admin@company.test --admin-password "ChangeMe-12345"
 * Optional: --admin-name, --country (default US), --timezone (default UTC).
 */
const { values } = parseArgs({
  options: {
    'admin-email': { type: 'string' },
    'admin-password': { type: 'string' },
    'admin-name': { type: 'string', default: 'Admin' },
    country: { type: 'string', default: 'US' },
    timezone: { type: 'string', default: 'UTC' },
  },
});

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    await prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, defaultCountryCode: values.country!.toUpperCase(), defaultTimezone: values.timezone! },
      update: {},
    });
    console.log('Settings ready (opt-out: STOP, UNSUBSCRIBE; opt-in: START).');

    const email = values['admin-email']?.trim().toLowerCase();
    const password = values['admin-password'];
    if (!email || !password) {
      console.log('No --admin-email/--admin-password given; skipped admin creation.');
      return;
    }
    if (password.length < 12) throw new Error('Admin password must be at least 12 characters.');

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`User ${email} already exists; left unchanged.`);
      return;
    }
    await prisma.user.create({
      data: {
        email,
        name: values['admin-name']!,
        role: 'ADMIN',
        status: 'ACTIVE',
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      },
    });
    console.log(`Admin ${email} created.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
