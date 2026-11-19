// Sends a signed inbound customer message to the API (T065), e.g.:
//   npm run mock:inbound -- --from +971500000001 --text STOP
import { parseArgs } from 'node:util';
import { env } from './env.js';
import { inboundPayload, postSigned } from './webhook-emitter.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    text: { type: 'string' },
    'phone-number-id': { type: 'string', default: 'MOCK_PHONE' },
    waba: { type: 'string', default: 'MOCK_WABA' },
  },
});

if (!values.from || values.text === undefined) {
  console.error('Usage: npm run mock:inbound -- --from <phone> --text <text> [--phone-number-id <id>] [--waba <id>]');
  process.exit(1);
}

const status = await postSigned(
  inboundPayload({
    wabaId: values.waba!,
    phoneNumberId: values['phone-number-id']!,
    from: values.from.replace(/^\+/, ''),
    text: values.text,
  }),
);
console.log(`Posted inbound message to ${env.webhookTarget} -> HTTP ${status}`);
process.exit(status >= 200 && status < 300 ? 0 : 1);
