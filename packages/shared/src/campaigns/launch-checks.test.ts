import { describe, expect, it } from 'vitest';
import { cardMediaProblem, duplicateRowsProblem, mediaResponseProblem, mediaUrlFormatProblem, offerEndProblem } from './launch-checks.js';

// T008 (feature 009, research R6, R7, R9, R10): launch rules.
const now = new Date('2026-12-01T10:00:00Z');
const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('offerEndProblem', () => {
  it('needs an end in the future and after the scheduled start', () => {
    expect(offerEndProblem(hours(48), null, now)).toBeNull();
    expect(offerEndProblem(hours(48), hours(24), now)).toBeNull();
    expect(offerEndProblem(now, null, now)).toBe('OFFER_ENDED');
    expect(offerEndProblem(hours(-1), null, now)).toBe('OFFER_ENDED');
    expect(offerEndProblem(hours(24), hours(24), now)).toBe('OFFER_ENDS_BEFORE_START');
    expect(offerEndProblem(hours(10), hours(24), now)).toBe('OFFER_ENDS_BEFORE_START');
  });
});

describe('cardMediaProblem', () => {
  it('matches the card format and the size limits', () => {
    expect(cardMediaProblem('IMAGE', { mimeType: 'image/png', sizeBytes: 1_000 })).toBeNull();
    expect(cardMediaProblem('IMAGE', { mimeType: 'video/mp4', sizeBytes: 1_000 })).toBe('WRONG_TYPE');
    expect(cardMediaProblem('IMAGE', { mimeType: 'image/jpeg', sizeBytes: 5 * 1024 * 1024 + 1 })).toBe('TOO_LARGE');
    expect(cardMediaProblem('VIDEO', { mimeType: 'video/mp4', sizeBytes: 16 * 1024 * 1024 })).toBeNull();
  });
});

describe('media addresses', () => {
  it('need https', () => {
    expect(mediaUrlFormatProblem('https://files.example.com/invoice.pdf')).toBeNull();
    expect(mediaUrlFormatProblem('http://files.example.com/invoice.pdf')).toBe('NOT_HTTPS');
    expect(mediaUrlFormatProblem('not a url')).toBe('NOT_HTTPS');
  });

  it('check the answer type and size against the header', () => {
    expect(mediaResponseProblem('DOCUMENT', 'application/pdf', 1_000)).toBeNull();
    expect(mediaResponseProblem('DOCUMENT', 'application/pdf; charset=binary', null)).toBeNull();
    expect(mediaResponseProblem('DOCUMENT', 'text/html', 1_000)).toBe('WRONG_TYPE');
    expect(mediaResponseProblem('IMAGE', null, null)).toBe('WRONG_TYPE');
    expect(mediaResponseProblem('IMAGE', 'image/png', 6 * 1024 * 1024)).toBe('TOO_LARGE');
  });
});

describe('duplicateRowsProblem', () => {
  it('allows "send to every row" only for uploads', () => {
    expect(duplicateRowsProblem('UPLOAD', true)).toBeNull();
    expect(duplicateRowsProblem('FILTER', false)).toBeNull();
    expect(duplicateRowsProblem('FILTER', true)).toBe('DUPLICATES_NEED_UPLOAD');
  });
});
