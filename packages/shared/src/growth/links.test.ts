import { describe, expect, it } from 'vitest';
import {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  destinationProblem,
  isLinkCode,
  isTrackedButtonUrl,
  makeLinkCode,
  trackedButtonUrl,
  trackedLinkUrl,
  withCampaignTags,
} from './links.js';

// T006 (feature 005, research R1-R2): codes, destinations and campaign tags.
describe('link codes', () => {
  it('makes 10 characters from [0-9A-Za-z] with the random source it is given', () => {
    expect(LINK_CODE_LENGTH).toBe(10);
    expect(LINK_CODE_ALPHABET).toHaveLength(62);
    expect(makeLinkCode(() => 0)).toBe('0000000000');
    expect(makeLinkCode((max) => max - 1)).toBe('zzzzzzzzzz');
    let i = 0;
    const code = makeLinkCode((max) => (i++ * 7) % max);
    expect(code).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(isLinkCode(code)).toBe(true);
  });

  it('recognises only well-formed codes', () => {
    expect(isLinkCode('AbCdEf1234')).toBe(true);
    expect(isLinkCode('AbCdEf123')).toBe(false);
    expect(isLinkCode('AbCdEf12345')).toBe(false);
    expect(isLinkCode('AbCdEf123-')).toBe(false);
    expect(isLinkCode('')).toBe(false);
  });
});

describe('tracked addresses', () => {
  it('builds the short link and the URL button address from the base, with or without a trailing slash', () => {
    expect(trackedLinkUrl('https://go.company.example/l', 'AbCdEf1234')).toBe('https://go.company.example/l/AbCdEf1234');
    expect(trackedLinkUrl('https://go.company.example/', 'AbCdEf1234')).toBe('https://go.company.example/AbCdEf1234');
    expect(trackedButtonUrl('https://go.company.example/l/')).toBe('https://go.company.example/l/{{1}}');
  });

  it('tracks a URL button only when its address is the base followed by /{{1}}', () => {
    const base = 'https://go.company.example/l';
    expect(isTrackedButtonUrl('https://go.company.example/l/{{1}}', base)).toBe(true);
    expect(isTrackedButtonUrl('https://go.company.example/l/{{1}}', `${base}/`)).toBe(true);
    expect(isTrackedButtonUrl('https://shop.example/{{1}}', base)).toBe(false);
    expect(isTrackedButtonUrl('https://go.company.example/l/sale/{{1}}', base)).toBe(false);
    expect(isTrackedButtonUrl('https://go.company.example/l/', base)).toBe(false);
    expect(isTrackedButtonUrl('https://go.company.example/l/{{1}}', undefined)).toBe(false);
  });
});

describe('destinationProblem', () => {
  const base = 'https://go.company.example/l';

  it('accepts https and http addresses of up to 2,000 characters', () => {
    expect(destinationProblem('https://shop.example/sale?ref=wa', base)).toBeNull();
    expect(destinationProblem('http://shop.example/sale', base)).toBeNull();
    expect(destinationProblem(`https://shop.example/${'a'.repeat(2000 - 21)}`, base)).toBeNull();
  });

  it('refuses other schemes, broken addresses, long addresses and links back to the tracking address', () => {
    expect(destinationProblem('ftp://shop.example/file', base)).toBe('NOT_HTTP');
    expect(destinationProblem('javascript:alert(1)', base)).toBe('NOT_HTTP');
    expect(destinationProblem('shop.example/sale', base)).toBe('INVALID_URL');
    expect(destinationProblem('https://', base)).toBe('INVALID_URL');
    expect(destinationProblem(`https://shop.example/${'a'.repeat(2000)}`, base)).toBe('TOO_LONG');
    expect(destinationProblem('https://go.company.example/l/AbCdEf1234', base)).toBe('ON_TRACKING_ADDRESS');
    expect(destinationProblem('https://GO.company.example/l/x', base)).toBe('ON_TRACKING_ADDRESS');
    expect(destinationProblem('https://go.company.example/other', base)).toBeNull();
  });
});

describe('withCampaignTags', () => {
  it('adds the WhatsApp campaign tags and keeps existing query parameters and the fragment', () => {
    expect(withCampaignTags('https://shop.example/sale', 'Summer Sale')).toBe(
      'https://shop.example/sale?utm_source=whatsapp&utm_medium=message&utm_campaign=Summer%20Sale',
    );
    expect(withCampaignTags('https://shop.example/sale?ref=a%20b&x=1#top', 'Eid')).toBe(
      'https://shop.example/sale?ref=a%20b&x=1&utm_source=whatsapp&utm_medium=message&utm_campaign=Eid#top',
    );
  });

  it('keeps tags the address already has', () => {
    expect(withCampaignTags('https://shop.example/?utm_campaign=own', 'Eid')).toBe(
      'https://shop.example/?utm_campaign=own&utm_source=whatsapp&utm_medium=message',
    );
    expect(withCampaignTags('https://shop.example/?utm_source=a&utm_medium=b&utm_campaign=c', 'Eid')).toBe(
      'https://shop.example/?utm_source=a&utm_medium=b&utm_campaign=c',
    );
  });
});
