import { describe, expect, it } from 'vitest';
import { KeywordRepliesSchema, keywordReplyKey, readKeywordReply } from '../../src/modules/settings/keyword-replies.js';

// Feature 010 (US4, T050): what a keyword reply may hold.
const TEMPLATE_ID = '0190a000-0000-7000-8000-00000000abcd';

describe('keyword replies', () => {
  it('needs a text for a text reply and a template for a template reply', () => {
    expect(KeywordRepliesSchema.safeParse({ optOut: { kind: 'TEXT', text: 'You will get no more messages.' }, optIn: { kind: 'NONE' } }).success).toBe(true);
    expect(KeywordRepliesSchema.safeParse({ optOut: { kind: 'TEXT', text: '   ' }, optIn: { kind: 'NONE' } }).success).toBe(false);
    expect(KeywordRepliesSchema.safeParse({ optOut: { kind: 'TEXT', text: 'x'.repeat(1025) }, optIn: { kind: 'NONE' } }).success).toBe(false);
    expect(KeywordRepliesSchema.safeParse({ optOut: { kind: 'NONE' }, optIn: { kind: 'TEMPLATE' } }).success).toBe(false);
    expect(KeywordRepliesSchema.safeParse({ optOut: { kind: 'NONE' }, optIn: { kind: 'TEMPLATE', templateId: TEMPLATE_ID, variables: { 'BODY.1': { source: 'field', key: 'name' } } } }).success).toBe(true);
    expect(KeywordRepliesSchema.safeParse({ optOut: { kind: 'NONE' } }).success).toBe(false);
  });

  it('reads stored replies, treating anything unreadable as no reply', () => {
    expect(readKeywordReply({ kind: 'TEXT', text: ' Done. ' })).toEqual({ kind: 'TEXT', text: 'Done.' });
    expect(readKeywordReply({ kind: 'TEMPLATE', templateId: TEMPLATE_ID })).toEqual({ kind: 'TEMPLATE', templateId: TEMPLATE_ID, variables: {} });
    expect(readKeywordReply({ kind: 'TEXT' })).toEqual({ kind: 'NONE' });
    expect(readKeywordReply(null)).toEqual({ kind: 'NONE' });
    expect(readKeywordReply('nonsense')).toEqual({ kind: 'NONE' });
  });

  it('keeps one guard per contact and kind', () => {
    expect(keywordReplyKey('OPT_OUT', 'c1')).toBe('wbm:kwreply:opt_out:c1');
    expect(keywordReplyKey('OPT_IN', 'c1')).toBe('wbm:kwreply:opt_in:c1');
  });
});
