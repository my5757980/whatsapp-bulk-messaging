import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Loads the nearest `.env`, walking up from the working directory. In this monorepo the file
 * lives at the repo root while scripts run inside apps/api. Existing env vars always win.
 */
export function loadEnvFile(start: string = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      config({ path: candidate, quiet: true });
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

loadEnvFile();
