import { describe, expect, it } from 'vitest';
import { freeWindow, parseAdReferral } from './referral.js';

// T009 (feature 007, research R11): referrals from ads and Meta's free window.
describe('ad referrals', () => {
  it('reads an ad referral and ignores posts and referrals without an ad', () => {
    expect(
      parseAdReferral({
        source_url: 'https://fb.me/abc',
        source_id: '120200000001',
        source_type: 'ad',
        headline: 'Spring sale',
        body: '30% off shoes',
        media_type: 'image',
        image_url: 'https://cdn.example/ad.jpg',
        ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ',
      }),
    ).toEqual({
      metaAdId: '120200000001',
      headline: 'Spring sale',
      body: '30% off shoes',
      mediaType: 'image',
      mediaUrl: 'https://cdn.example/ad.jpg',
      sourceUrl: 'https://fb.me/abc',
      ctwaClid: 'ARAkLkA8rmlFeiCktEJQ',
    });
    // WhatsApp Status placements leave ctwa_clid out; video ads give a video or thumbnail URL.
    expect(parseAdReferral({ source_id: '1', source_type: 'ad', video_url: 'https://cdn.example/v.mp4' })).toMatchObject({ ctwaClid: null, mediaUrl: 'https://cdn.example/v.mp4' });
    expect(parseAdReferral({ source_id: '1', source_type: 'post' })).toBeNull();
    expect(parseAdReferral({ source_url: 'https://fb.me/abc' })).toBeNull();
    expect(parseAdReferral(null)).toBeNull();
    expect(parseAdReferral({ source_id: '1', source_type: 'ad', headline: 'x'.repeat(600) })!.headline).toHaveLength(500);
  });

  it('opens the free window when the business replies within 24 hours', () => {
    const start = new Date('2026-11-25T10:00:00Z');
    const hour = 3_600_000;
    expect(freeWindow(start, null, new Date(start.getTime() + hour), 72)).toEqual({ state: 'REPLY_TO_OPEN', replyBy: new Date(start.getTime() + 24 * hour) });
    expect(freeWindow(start, null, new Date(start.getTime() + 25 * hour), 72)).toEqual({ state: 'MISSED' });
    const reply = new Date(start.getTime() + 2 * hour);
    expect(freeWindow(start, reply, new Date(start.getTime() + 3 * hour), 72)).toEqual({ state: 'OPEN', until: new Date(reply.getTime() + 72 * hour) });
    expect(freeWindow(start, reply, new Date(reply.getTime() + 73 * hour), 72)).toEqual({ state: 'ENDED', until: new Date(reply.getTime() + 72 * hour) });
    expect(freeWindow(start, new Date(start.getTime() + 25 * hour), new Date(start.getTime() + 26 * hour), 72)).toEqual({ state: 'MISSED' });
    expect(freeWindow(start, reply, reply, 168)).toEqual({ state: 'OPEN', until: new Date(reply.getTime() + 168 * hour) });
  });
});
