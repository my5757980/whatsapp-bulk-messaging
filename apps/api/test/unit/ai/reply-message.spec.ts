import { describe, expect, it } from 'vitest';
import { replyItems, replyOptionId, type ReplyItemContext } from '../../../src/modules/ai/turns/reply-message.js';

// 004 T064: the WhatsApp message an AI reply becomes (FR-028).
const conversationId = '0190a000-0000-7000-8000-000000000001';
const ctx: ReplyItemContext = { aiConversationId: conversationId, media: null, allowButtons: true, allowLists: true };
const none = { buttons: null, list: null, mediaId: null };
const pdf = { id: '0190a000-0000-7000-8000-0000000000aa', mimeType: 'application/pdf', sizeBytes: 120_000, displayName: 'Price list.pdf' };

describe('AI reply messages (T064)', () => {
  it('sends plain text', () => {
    expect(replyItems('We open at 9.', none, ctx)).toEqual([{ contentType: 'TEXT', text: 'We open at 9.', mediaAssetId: null, payload: {} }]);
  });

  it('sends up to 3 buttons as a BUTTONS item whose reply ids name the AI conversation', () => {
    const [item] = replyItems('Which size?', { ...none, buttons: ['Small', 'Medium', 'Large'] }, ctx);
    expect(item).toEqual({
      contentType: 'BUTTONS',
      text: 'Which size?',
      mediaAssetId: null,
      payload: {
        header: null,
        footer: null,
        buttons: [
          { id: `ai:${conversationId}:1`, title: 'Small' },
          { id: `ai:${conversationId}:2`, title: 'Medium' },
          { id: `ai:${conversationId}:3`, title: 'Large' },
        ],
      },
    });
    expect(replyOptionId(conversationId, 2)).toBe(`ai:${conversationId}:2`);
  });

  it('sends 4 to 10 options as a LIST item', () => {
    const rows = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Al Ain'].map((title) => ({ title, description: title === 'Al Ain' ? 'Opens at 10' : null }));
    const [item] = replyItems('Choose your city', { ...none, list: { button: 'Cities', rows } }, ctx);
    expect(item!.contentType).toBe('LIST');
    expect(item!.payload).toMatchObject({ buttonLabel: 'Cities', sections: [{ title: null, rows: expect.any(Array) }] });
    const sent = (item!.payload.sections as Array<{ rows: Array<{ id: string; title: string; description: string | null }> }>)[0]!.rows;
    expect(sent).toHaveLength(5);
    expect(sent[4]).toEqual({ id: `ai:${conversationId}:5`, title: 'Al Ain', description: 'Opens at 10' });
  });

  it('sends a shared file with the message as its caption, at most 1,024 characters', () => {
    const [item] = replyItems('Here is our price list.', { ...none, mediaId: pdf.id }, { ...ctx, media: pdf });
    expect(item).toEqual({
      contentType: 'DOCUMENT',
      text: 'Here is our price list.',
      mediaAssetId: pdf.id,
      payload: { mimeType: 'application/pdf', sizeBytes: 120_000, fileName: 'Price list.pdf' },
    });
    const [long] = replyItems('x'.repeat(1500), { ...none, mediaId: pdf.id }, { ...ctx, media: pdf });
    expect([...long!.text!]).toHaveLength(1024);
    expect(long!.text!.endsWith('…')).toBe(true);
  });

  it('sends the text first for audio, which cannot carry a caption', () => {
    const audio = { id: '0190a000-0000-7000-8000-0000000000bb', mimeType: 'audio/ogg', sizeBytes: 50_000, displayName: 'Welcome' };
    expect(replyItems('Listen to this.', { ...none, mediaId: audio.id }, { ...ctx, media: audio }).map((i) => [i.contentType, i.text])).toEqual([
      ['TEXT', 'Listen to this.'],
      ['AUDIO', null],
    ]);
  });

  it('falls back to text when buttons or lists are switched off or the file cannot be sent', () => {
    expect(replyItems('Which size?', { ...none, buttons: ['Small'] }, { ...ctx, allowButtons: false })[0]!.contentType).toBe('TEXT');
    expect(replyItems('Pick one', { ...none, list: { button: 'Options', rows: [{ title: 'A', description: null }] } }, { ...ctx, allowLists: false })[0]!.contentType).toBe('TEXT');
    const tooBig = { ...pdf, sizeBytes: 500 * 1024 * 1024 };
    expect(replyItems('Here it is.', { ...none, mediaId: pdf.id }, { ...ctx, media: tooBig })).toEqual([{ contentType: 'TEXT', text: 'Here it is.', mediaAssetId: null, payload: {} }]);
  });
});
