import { describe, expect, it } from 'vitest';
import { CHAT_REF_ALPHABET, chatLinkUrl, findChatRef, isChatRef, makeChatRef, messageWithRef, waMeUrl } from './chat-links.js';

// T069 (feature 006 US7, research R12): chat link references, the message, wa.me addresses and matching.
describe('chat links', () => {
  it('makes 6-character references without look-alike characters', () => {
    expect(CHAT_REF_ALPHABET).not.toMatch(/[01ILO]/);
    let i = 0;
    const ref = makeChatRef((max) => (i++ * 7) % max);
    expect(ref).toHaveLength(6);
    expect(isChatRef(ref)).toBe(true);
    expect(isChatRef('ABC12O')).toBe(false);
    expect(isChatRef('ABC1')).toBe(false);
  });

  it('adds the reference to the message, within limits', () => {
    expect(messageWithRef('  Hi, I saw your poster ', 'K7QX2M')).toBe('Hi, I saw your poster (ref K7QX2M)');
    expect(messageWithRef('x'.repeat(600), 'K7QX2M')).toHaveLength(500 + ' (ref K7QX2M)'.length);
  });

  it('builds wa.me addresses with digits only and encoded text', () => {
    expect(waMeUrl('+971 50 123 4567', 'Hi & hello (ref K7QX2M)')).toBe('https://wa.me/971501234567?text=Hi%20%26%20hello%20(ref%20K7QX2M)');
    expect(chatLinkUrl('https://go.example/', 'Ab3dEf9hJk')).toBe('https://go.example/c/Ab3dEf9hJk');
  });

  it('finds the last reference, and nothing when it was edited', () => {
    expect(findChatRef('Hi (ref AAAAAA) again (ref K7QX2M)')).toBe('K7QX2M');
    expect(findChatRef('hi (ref k7qx2m)')).toBe('K7QX2M');
    expect(findChatRef('Hi (ref K7QX2O)')).toBeNull();
    expect(findChatRef('Hi (ref K7QX2)')).toBeNull();
    expect(findChatRef('Hi there')).toBeNull();
    expect(findChatRef(null)).toBeNull();
  });
});
