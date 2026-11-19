// Sends a signed inbound customer message of any type to the API (001 T065, 002 T004), e.g.:
//   npm run mock:inbound -- --from +971500000001 --text STOP
//   npm run mock:inbound -- --from +971500000001 --name "Sara" --image samples/media/photo.jpg --caption "this one"
//   npm run mock:inbound -- --from +971500000001 --location 25.2048,55.2708 --label "Office"
//   npm run mock:inbound -- --from +971500000001 --reaction "👍" --to-wamid <wamid>
//   npm run mock:inbound -- --from +971500000002 --at "-25h" --text "old"
// It covers every type in specs/002-team-inbox/contracts/meta-graph-inbox.md §1. Media files go to
// mock-meta first, which then serves them through GET /{media-id} the way Meta does.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { env } from './env.js';
import { inboundMessagePayload, postSigned, type InboundMessage } from './webhook-emitter.js';

const USAGE = `Usage: npm run mock:inbound -- --from <phone> <one content flag> [options]

Content (exactly one):
  --text <text>                  --image <file>   --video <file>   --sticker <file>
  --audio <file> [--voice]       --document <file> [--filename <name>]
  --location <lat,lng> [--label <name>] [--address <text>]
  --contact-card "<name>,<phone>"
  --button-reply <title>         --quick-reply <text>   (a template quick-reply button)
  --list-reply <title> [--description <text>]
  --form-reply '<json>'          --reaction <emoji> --to-wamid <wamid>   (an empty emoji removes it)
  --unsupported

Options:
  --name <profile name>   --caption <text>   --reply-to <wamid>   --wamid <fixed id>
  --at <offset>           message time relative to now, e.g. -25h, -30m, -2d
  --phone-number-id <id>  (default MOCK_PHONE)    --waba <id> (default MOCK_WABA)`;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.ogg': 'audio/ogg; codecs=opus',
  '.opus': 'audio/ogg; codecs=opus',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const CONTENT_FLAGS = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact-card',
  'button-reply',
  'quick-reply',
  'list-reply',
  'form-reply',
  'reaction',
  'unsupported',
] as const;

// parseArgs refuses option values that start with "-" ("--at -25h"), so pass them as "--at=-25h".
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] === '--at' && argv[i + 1]?.startsWith('-')) argv.splice(i, 2, `--at=${argv[i + 1]}`);
}

const { values } = parseArgs({
  args: argv,
  options: {
    from: { type: 'string' },
    name: { type: 'string', default: 'Mock Customer' },
    text: { type: 'string' },
    image: { type: 'string' },
    video: { type: 'string' },
    audio: { type: 'string' },
    voice: { type: 'boolean', default: false },
    document: { type: 'string' },
    sticker: { type: 'string' },
    caption: { type: 'string' },
    filename: { type: 'string' },
    location: { type: 'string' },
    label: { type: 'string' },
    address: { type: 'string' },
    'contact-card': { type: 'string' },
    'button-reply': { type: 'string' },
    'quick-reply': { type: 'string' },
    'list-reply': { type: 'string' },
    description: { type: 'string' },
    'form-reply': { type: 'string' },
    reaction: { type: 'string' },
    'to-wamid': { type: 'string' },
    unsupported: { type: 'boolean', default: false },
    'reply-to': { type: 'string' },
    wamid: { type: 'string' },
    at: { type: 'string' },
    'phone-number-id': { type: 'string', default: 'MOCK_PHONE' },
    waba: { type: 'string', default: 'MOCK_WABA' },
    help: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

/** "-25h" -> milliseconds. Units: s, m, h, d. */
function offsetMs(value: string): number {
  const match = /^([+-]?)(\d+)([smhd])$/.exec(value.trim());
  if (!match) fail(`--at must look like -25h, -30m or -2d (got "${value}")`);
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[3] as 's' | 'm' | 'h' | 'd'];
  return (match[1] === '-' ? -1 : 1) * Number(match[2]) * unitMs;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'option';

/** Stores a local file in mock-meta and returns the media fields Meta puts in the webhook. */
async function uploadMedia(path: string) {
  // npm runs workspace scripts inside tools/mock-meta, so resolve from where the command was typed.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), path);
  const bytes = await readFile(file).catch(() => fail(`Cannot read the file ${file}`));
  const mimeType = MIME_BY_EXTENSION[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const res = await fetch(`${env.baseUrl}/mock/media?mime_type=${encodeURIComponent(mimeType)}`, { method: 'POST', body: bytes }).catch(() =>
    fail(`mock-meta is not reachable at ${env.baseUrl}. Start it with: npm run dev -w @wbm/mock-meta`),
  );
  if (!res.ok) fail(`mock-meta refused the file: HTTP ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  return { id, mime_type: mimeType, sha256: createHash('sha256').update(bytes).digest('hex'), filename: basename(file) };
}

/** The type-specific part of the message for the one content flag given. */
async function buildContent(): Promise<Record<string, unknown>> {
  const all = values as Record<string, string | boolean | undefined>;
  const given = CONTENT_FLAGS.filter((flag) => all[flag] !== undefined && all[flag] !== false);
  if (given.length !== 1) {
    fail(given.length === 0 ? 'Give one content flag.' : `Give only one content flag (got ${given.map((f) => `--${f}`).join(', ')}).`);
  }
  const flag = given[0]!;
  const caption = values.caption ? { caption: values.caption } : {};

  switch (flag) {
    case 'text':
      return { type: 'text', text: { body: values.text } };
    case 'image':
    case 'video': {
      const m = await uploadMedia(String(all[flag]));
      return { type: flag, [flag]: { id: m.id, mime_type: m.mime_type, sha256: m.sha256, ...caption } };
    }
    case 'sticker': {
      const m = await uploadMedia(values.sticker!);
      return { type: 'sticker', sticker: { id: m.id, mime_type: m.mime_type, sha256: m.sha256, animated: false } };
    }
    case 'audio': {
      const m = await uploadMedia(values.audio!);
      return { type: 'audio', audio: { id: m.id, mime_type: m.mime_type, sha256: m.sha256, voice: values.voice } };
    }
    case 'document': {
      const m = await uploadMedia(values.document!);
      return { type: 'document', document: { id: m.id, mime_type: m.mime_type, sha256: m.sha256, filename: values.filename ?? m.filename, ...caption } };
    }
    case 'location': {
      const [latitude, longitude] = values.location!.split(',').map((part) => Number(part.trim()));
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) fail('--location must look like 25.2048,55.2708');
      return {
        type: 'location',
        location: { latitude, longitude, ...(values.label ? { name: values.label } : {}), ...(values.address ? { address: values.address } : {}) },
      };
    }
    case 'contact-card': {
      const [name, phone] = values['contact-card']!.split(',').map((part) => part.trim());
      if (!name || !phone) fail('--contact-card must look like "Ali Khan,+971500000099"');
      return {
        type: 'contacts',
        contacts: [{ name: { formatted_name: name, first_name: name.split(' ')[0] }, phones: [{ phone, wa_id: phone.replace(/\D/g, ''), type: 'CELL' }] }],
      };
    }
    case 'button-reply': {
      const title = values['button-reply']!;
      return { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: slug(title), title } } };
    }
    case 'quick-reply': {
      const text = values['quick-reply']!;
      return { type: 'button', button: { text, payload: text } };
    }
    case 'list-reply': {
      const title = values['list-reply']!;
      const description = values.description ? { description: values.description } : {};
      return { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: slug(title), title, ...description } } };
    }
    case 'form-reply': {
      const json = values['form-reply']!;
      try {
        JSON.parse(json);
      } catch {
        fail('--form-reply must be JSON, e.g. \'{"name":"Sara"}\'');
      }
      return { type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: json } } };
    }
    case 'reaction':
      if (!values['to-wamid']) fail('--reaction needs --to-wamid <wamid of the message reacted to>');
      return { type: 'reaction', reaction: { message_id: values['to-wamid'], emoji: values.reaction } };
    case 'unsupported':
      return {
        type: 'unsupported',
        errors: [{ code: 131051, title: 'Message type unknown', message: 'Message type unknown', error_data: { details: 'Message type is currently not supported.' } }],
      };
  }
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.from) fail('--from is required.');

const content = await buildContent();
const message = {
  from: values.from.replace(/^\+/, ''),
  id: values.wamid ?? `wamid.in.${Date.now()}${Math.floor(Math.random() * 1000)}`,
  timestamp: String(Math.floor((Date.now() + (values.at ? offsetMs(values.at) : 0)) / 1000)),
  ...content,
  ...(values['reply-to'] ? { context: { from: '15550100', id: values['reply-to'] } } : {}),
} as InboundMessage;

const status = await postSigned(
  inboundMessagePayload({ wabaId: values.waba!, phoneNumberId: values['phone-number-id']!, name: values.name!, message }),
);
console.log(`Posted ${message.type} message ${message.id} to ${env.webhookTarget} -> HTTP ${status}`);
process.exit(status >= 200 && status < 300 ? 0 : 1);
