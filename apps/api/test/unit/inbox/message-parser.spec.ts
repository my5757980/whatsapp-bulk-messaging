import { describe, expect, it } from 'vitest';
import { parseInboundMessage, previewOf } from '../../../src/modules/inbox/inbound/message-parser.js';

// T009: every inbound type in specs/002-team-inbox/contracts/meta-graph-inbox.md §1.
const base = { from: '971500000001', id: 'wamid.IN1', timestamp: '1795060800' }; // 2026-11-19T04:00:00Z
const contacts = [{ wa_id: '971500000001', profile: { name: 'Sara Khan' } }];
const parse = (message: Record<string, unknown>) => parseInboundMessage({ ...base, ...message }, contacts);

describe('parseInboundMessage', () => {
  it('reads the common fields and the profile name', () => {
    const parsed = parse({ type: 'text', text: { body: 'Is the blue one available?' } });
    expect(parsed).toEqual({
      waMessageId: 'wamid.IN1',
      waId: '971500000001',
      profileName: 'Sara Khan',
      occurredAt: new Date('2026-11-19T04:00:00.000Z'),
      contentType: 'TEXT',
      text: 'Is the blue one available?',
      payload: {},
      media: null,
      replyToWaId: null,
      adReferral: null,
    });
  });

  it('keeps the referral of a message from a Click-to-WhatsApp ad in the payload (feature 007)', () => {
    const parsed = parse({
      type: 'text',
      text: { body: 'Hi, I saw your ad' },
      referral: { source_url: 'https://fb.me/abc', source_id: '120200000001', source_type: 'ad', headline: 'Spring sale', body: '30% off', media_type: 'image', image_url: 'https://cdn.example/ad.jpg', ctwa_clid: 'CLID1' },
    });
    const referral = { metaAdId: '120200000001', headline: 'Spring sale', body: '30% off', mediaType: 'image', mediaUrl: 'https://cdn.example/ad.jpg', sourceUrl: 'https://fb.me/abc', ctwaClid: 'CLID1' };
    expect(parsed).toMatchObject({ contentType: 'TEXT', text: 'Hi, I saw your ad', payload: { referral }, adReferral: referral });
    // A referral from a post, not an ad, is not an ad chat.
    expect(parse({ type: 'text', text: { body: 'hi' }, referral: { source_id: '1', source_type: 'post' } })).toMatchObject({ payload: {}, adReferral: null });
  });

  it('keeps the message a customer replied to', () => {
    expect(parse({ type: 'text', text: { body: 'yes' }, context: { from: '15550100', id: 'wamid.OUT9' } })?.replyToWaId).toBe('wamid.OUT9');
  });

  it('reads pictures, videos and stickers with their media IDs', () => {
    expect(parse({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'this one' } })).toMatchObject({
      contentType: 'IMAGE',
      text: 'this one',
      payload: { mimeType: 'image/jpeg' },
      media: { metaMediaId: 'm1', mimeType: 'image/jpeg' },
    });
    expect(parse({ type: 'video', video: { id: 'm2', mime_type: 'video/mp4' } })).toMatchObject({ contentType: 'VIDEO', text: null, media: { metaMediaId: 'm2' } });
    expect(parse({ type: 'sticker', sticker: { id: 'm3', mime_type: 'image/webp', animated: false } })).toMatchObject({
      contentType: 'STICKER',
      media: { metaMediaId: 'm3', mimeType: 'image/webp' },
    });
  });

  it('reads documents with their file name', () => {
    expect(parse({ type: 'document', document: { id: 'm4', mime_type: 'application/pdf', filename: 'menu.pdf', caption: 'prices' } })).toMatchObject({
      contentType: 'DOCUMENT',
      text: 'prices',
      payload: { fileName: 'menu.pdf', mimeType: 'application/pdf' },
      media: { metaMediaId: 'm4' },
    });
  });

  it('tells voice notes from audio files', () => {
    expect(parse({ type: 'audio', audio: { id: 'm5', mime_type: 'audio/ogg; codecs=opus', voice: true } })).toMatchObject({
      contentType: 'AUDIO',
      payload: { voice: true },
      media: { metaMediaId: 'm5' },
    });
    expect(parse({ type: 'audio', audio: { id: 'm6', mime_type: 'audio/mpeg' } })?.payload).toMatchObject({ voice: false });
  });

  it('reads locations', () => {
    expect(parse({ type: 'location', location: { latitude: 25.2048, longitude: 55.2708, name: 'Office', address: 'Sheikh Zayed Rd' } })).toMatchObject({
      contentType: 'LOCATION',
      payload: { latitude: 25.2048, longitude: 55.2708, name: 'Office', address: 'Sheikh Zayed Rd' },
    });
  });

  it('reads contact cards', () => {
    const parsed = parse({
      type: 'contacts',
      contacts: [{ name: { formatted_name: 'Ali Khan', first_name: 'Ali' }, phones: [{ phone: '+971500000099', wa_id: '971500000099' }], emails: [{ email: 'ali@example.com' }] }],
    });
    expect(parsed).toMatchObject({
      contentType: 'CONTACTS',
      payload: { contacts: [{ name: 'Ali Khan', phones: ['+971500000099'], emails: ['ali@example.com'] }] },
    });
  });

  it('reads button and list replies', () => {
    expect(parse({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes please' } } })).toMatchObject({
      contentType: 'BUTTON_REPLY',
      text: 'Yes please',
      payload: { id: 'yes', title: 'Yes please' },
    });
    expect(
      parse({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'blue', title: 'Blue', description: 'Size M' } } }),
    ).toMatchObject({ contentType: 'LIST_REPLY', text: 'Blue', payload: { id: 'blue', title: 'Blue', description: 'Size M' } });
  });

  it('reads template quick-reply taps', () => {
    expect(parse({ type: 'button', button: { text: 'Stop promotions', payload: 'STOP_PROMO' } })).toMatchObject({
      contentType: 'BUTTON_REPLY',
      text: 'Stop promotions',
      payload: { payload: 'STOP_PROMO', title: 'Stop promotions' },
    });
  });

  it('reads form replies', () => {
    expect(parse({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"size":"M"}' } } })).toMatchObject({
      contentType: 'FORM_REPLY',
      payload: { response: { size: 'M' } },
    });
  });

  it('reads reactions, including removed ones', () => {
    expect(parse({ type: 'reaction', reaction: { message_id: 'wamid.OUT1', emoji: '👍' } })).toMatchObject({
      contentType: 'REACTION',
      payload: { targetWaId: 'wamid.OUT1', emoji: '👍' },
    });
    expect(parse({ type: 'reaction', reaction: { message_id: 'wamid.OUT1' } })?.payload).toEqual({ targetWaId: 'wamid.OUT1', emoji: '' });
  });

  it('keeps unsupported and unknown types with Meta error details', () => {
    expect(parse({ type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }] })).toMatchObject({
      contentType: 'UNSUPPORTED',
      payload: { rawType: 'unsupported', errorCode: 131051, errorTitle: 'Message type unknown' },
    });
    expect(parse({ type: 'order', order: { catalog_id: 'x' } })).toMatchObject({ contentType: 'UNSUPPORTED', payload: { rawType: 'order' } });
  });

  it('works without a profile name', () => {
    expect(parseInboundMessage({ ...base, type: 'text', text: { body: 'hi' } }, [])?.profileName).toBeNull();
  });

  it('rejects malformed messages', () => {
    expect(parseInboundMessage({ type: 'text', text: { body: 'no id' } })).toBeNull();
    expect(parseInboundMessage(null)).toBeNull();
    expect(parseInboundMessage({ ...base, type: 'image', image: {} })).toBeNull(); // media without an ID
  });

  it('falls back to the current time for a bad timestamp', () => {
    const parsed = parseInboundMessage({ ...base, timestamp: 'soon', type: 'text', text: { body: 'hi' } });
    expect(Math.abs(parsed!.occurredAt.getTime() - Date.now())).toBeLessThan(5_000);
  });
});

describe('previewOf', () => {
  it('describes each type in a short line', () => {
    expect(previewOf({ contentType: 'TEXT', text: 'Hello', payload: {} })).toBe('Hello');
    expect(previewOf({ contentType: 'IMAGE', text: 'this one', payload: {} })).toBe('📷 Photo: this one');
    expect(previewOf({ contentType: 'AUDIO', text: null, payload: { voice: true } })).toBe('🎤 Voice message');
    expect(previewOf({ contentType: 'DOCUMENT', text: null, payload: { fileName: 'menu.pdf' } })).toBe('📄 menu.pdf');
    expect(previewOf({ contentType: 'LOCATION', text: null, payload: { name: 'Office' } })).toBe('📍 Office');
    expect(previewOf({ contentType: 'REACTION', text: null, payload: { emoji: '👍' } })).toBe('Reacted 👍');
    expect(previewOf({ contentType: 'UNSUPPORTED', text: null, payload: {} })).toBe('Unsupported message');
  });

  it('collapses whitespace and stays within 120 characters', () => {
    const preview = previewOf({ contentType: 'TEXT', text: `line one\n\nline two ${'x'.repeat(200)}`, payload: {} });
    expect(preview.startsWith('line one line two')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(120);
  });
});
