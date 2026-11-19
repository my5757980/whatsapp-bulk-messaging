import { describe, expect, it } from 'vitest';
import { checkChatMedia } from './chat-media-limits.js';

// T057: media limits for chat messages (spec FR-015).
const MB = 1024 * 1024;

describe('checkChatMedia', () => {
  it('accepts each type up to its limit', () => {
    expect(checkChatMedia('image/jpeg', 5 * MB)).toEqual({ ok: true, kind: 'image' });
    expect(checkChatMedia('image/png', 1_000)).toEqual({ ok: true, kind: 'image' });
    expect(checkChatMedia('video/mp4', 16 * MB)).toEqual({ ok: true, kind: 'video' });
    expect(checkChatMedia('video/3gpp', 1_000)).toEqual({ ok: true, kind: 'video' });
    expect(checkChatMedia('audio/ogg; codecs=opus', MB)).toEqual({ ok: true, kind: 'audio' });
    expect(checkChatMedia('audio/mpeg', MB)).toEqual({ ok: true, kind: 'audio' });
    expect(checkChatMedia('application/pdf', 100 * MB)).toEqual({ ok: true, kind: 'document' });
    expect(checkChatMedia('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', MB)).toEqual({ ok: true, kind: 'document' });
    expect(checkChatMedia('text/plain', 10)).toEqual({ ok: true, kind: 'document' });
  });

  it('refuses a file over its limit, naming the type and the limit', () => {
    expect(checkChatMedia('video/mp4', 20 * MB)).toEqual({ ok: false, code: 'FILE_TOO_LARGE', message: 'Videos can be at most 16 MB' });
    expect(checkChatMedia('image/png', 5 * MB + 1)).toEqual({ ok: false, code: 'FILE_TOO_LARGE', message: 'Images can be at most 5 MB' });
    expect(checkChatMedia('application/pdf', 100 * MB + 1)).toEqual({ ok: false, code: 'FILE_TOO_LARGE', message: 'Documents can be at most 100 MB' });
  });

  it('refuses formats WhatsApp does not accept in chats, listing the ones it does', () => {
    const gif = checkChatMedia('image/gif', 1_000);
    expect(gif).toMatchObject({ ok: false, code: 'UNSUPPORTED_FILE_TYPE' });
    expect(gif.ok === false && gif.message).toContain('JPEG, PNG');
    expect(checkChatMedia('application/zip', 1_000)).toMatchObject({ ok: false, code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('ignores letter case and parameters in the type', () => {
    expect(checkChatMedia('IMAGE/JPEG', 10)).toEqual({ ok: true, kind: 'image' });
    expect(checkChatMedia('audio/AAC ; foo=bar', 10)).toEqual({ ok: true, kind: 'audio' });
  });
});
