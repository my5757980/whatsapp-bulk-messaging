// Feature 010 (T003): prints the current authenticator code for a base32 secret, for the quickstart and manual
// checks of two-factor sign-in:
//   npm run tool:totp -w @wbm/api -- --secret <the base32 key shown at setup>
import { parseArgs } from 'node:util';
import { TOTP_STEP_SECONDS, totpCode } from '../src/common/auth/totp.js';

const { values } = parseArgs({ options: { secret: { type: 'string' } } });
if (!values.secret) {
  console.error('Usage: npm run tool:totp -w @wbm/api -- --secret <base32 secret>');
  process.exit(1);
}
const now = Date.now();
const left = TOTP_STEP_SECONDS - (Math.floor(now / 1000) % TOTP_STEP_SECONDS);
console.log(`${totpCode(values.secret, now)} (valid for ${left} more seconds)`);
