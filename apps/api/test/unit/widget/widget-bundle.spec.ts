import { describe, expect, it } from 'vitest';
// @ts-expect-error - a plain .mjs build script without types
import { buildWidget } from '../../../scripts/build-widget.mjs';

// T080 (feature 009 US8, SC-010, contracts/website-button.md §2): the built button file stays small and
// self-contained, and never touches cookies or storage.
describe('the built widget file', () => {
  it('is under 30 KB, one IIFE with no imports, cookies or storage', async () => {
    const code = (await buildWidget()) as string;
    expect(Buffer.byteLength(code)).toBeLessThan(30 * 1024);
    const body = code.trimStart().replace(/^"use strict";/, '');
    expect(body.startsWith('(()=>{') || body.startsWith('(function')).toBe(true);
    for (const forbidden of [/\bimport\s*[({"']/, /\brequire\(/, /document\.cookie/, /localStorage/, /sessionStorage/, /indexedDB/]) {
      expect(forbidden.test(code), String(forbidden)).toBe(false);
    }
    expect(code).toContain('__wbmChatButton');
  });
});
