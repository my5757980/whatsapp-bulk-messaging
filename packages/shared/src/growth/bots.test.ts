import { describe, expect, it } from 'vitest';
import { deviceKind, isPreviewRequest } from './bots.js';

// T007 (feature 005, research R3): previews and robots are redirected but never counted as clicks.
const PHONE_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const PHONE_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const CUBOT_PHONE =
  'Mozilla/5.0 (Linux; Android 9; CUBOT_X19) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

describe('isPreviewRequest', () => {
  it('counts ordinary browser visits as clicks', () => {
    for (const userAgent of [PHONE_ANDROID, PHONE_IPHONE, DESKTOP_CHROME, CUBOT_PHONE]) {
      expect(isPreviewRequest({ method: 'GET', userAgent })).toBe(false);
    }
    expect(isPreviewRequest({ method: 'GET' })).toBe(false);
  });

  it("treats WhatsApp's link preview fetcher as a preview on every platform", () => {
    expect(isPreviewRequest({ method: 'GET', userAgent: 'WhatsApp/2.24.20.72 A' })).toBe(true);
    expect(isPreviewRequest({ method: 'GET', userAgent: 'WhatsApp/2.22.20.72 i' })).toBe(true);
    expect(isPreviewRequest({ method: 'GET', userAgent: 'WhatsApp/2.23.2.72 W' })).toBe(true);
  });

  it('treats known preview fetchers and robots as previews', () => {
    for (const userAgent of [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Facebot',
      'Twitterbot/1.0',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'TelegramBot (like TwitterBot)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
      'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'Some link crawler 1.0',
      'acme-spider',
      'Mail scanner',
    ]) {
      expect(isPreviewRequest({ method: 'GET', userAgent }), userAgent).toBe(true);
    }
  });

  it('treats HEAD requests and prefetches as previews', () => {
    expect(isPreviewRequest({ method: 'HEAD', userAgent: PHONE_ANDROID })).toBe(true);
    expect(isPreviewRequest({ method: 'GET', userAgent: PHONE_ANDROID, purpose: 'prefetch' })).toBe(true);
    expect(isPreviewRequest({ method: 'GET', userAgent: PHONE_ANDROID, secPurpose: 'prefetch;prerender' })).toBe(true);
    expect(isPreviewRequest({ method: 'GET', userAgent: PHONE_ANDROID, purpose: 'navigate' })).toBe(false);
  });
});

describe('deviceKind', () => {
  it('tells phones from computers, and OTHER when there is no user agent', () => {
    expect(deviceKind(PHONE_ANDROID)).toBe('MOBILE');
    expect(deviceKind(PHONE_IPHONE)).toBe('MOBILE');
    expect(deviceKind('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('MOBILE');
    expect(deviceKind(DESKTOP_CHROME)).toBe('DESKTOP');
    expect(deviceKind(undefined)).toBe('OTHER');
    expect(deviceKind('   ')).toBe('OTHER');
  });
});
