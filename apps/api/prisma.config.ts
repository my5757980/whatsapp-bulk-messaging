import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The .env file lives at the repo root; an apps/api/.env (if any) takes precedence.
config({ path: ['.env', '../../.env'], quiet: true });

// Prisma ORM 7: datasource URL lives here, not in schema.prisma.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Local-dev default keeps `prisma generate` working before .env exists; never a production secret.
    url: process.env.DATABASE_URL ?? 'postgresql://wbm:wbm@localhost:5432/wbm',
  },
});
