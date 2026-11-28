// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, render, startLink, type WidgetConfig } from '../../../src/widget/chat-button.js';

// T080 (feature 009 US8, contracts/website-button.md §2): the website chat button script.
const config = (overrides: Partial<WidgetConfig> = {}): WidgetConfig => ({
  hidden: false,
  version: 'v1',
  look: { colour: '#0A7B55', buttonText: 'Chat with us', corner: 'BOTTOM_LEFT', offsetX: 24, offsetY: 30, radius: 20 },
  brandName: 'Lamp & Co',
  brandImageUrl: null,
  greeting: 'Hi! How can we help?',
  startUrl: 'https://go.example.com/c/DefaultAbc',
  rules: [
    { id: 'r1', match: 'EXACT', value: '/checkout', hide: true },
    { id: 'r2', match: 'PREFIX', value: '/products', hide: false, greeting: 'Questions about this product?', startUrl: 'https://go.example.com/c/ProductsXy' },
  ],
  ...overrides,
});

const script = (attrs: Record<string, string>) => {
  const el = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { __wbmChatButton?: boolean }).__wbmChatButton;
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('the chat button', () => {
  it('renders in a shadow root with the look settings and the default greeting', () => {
    window.history.replaceState({}, '', '/about');
    const root = render(window, config(), 'AbCdEfGhIjKl')!;
    expect(root).not.toBeNull();
    expect(document.querySelector('[data-wbm-chat-button]')!.shadowRoot).toBe(root);
    const style = root.querySelector('style')!.textContent!;
    expect(style).toContain('left: 24px');
    expect(style).toContain('bottom: 30px');
    expect(style).toContain('#0A7B55');
    expect(style).toContain('border-radius: 20px');
    expect(style).toContain('z-index: 2147483000');
    expect(root.querySelector('.open')!.textContent).toContain('Chat with us');
    expect(root.querySelector('.greeting')!.textContent).toBe('Hi! How can we help?');
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('uses the rule of the page, and shows nothing on a hidden page', () => {
    window.history.replaceState({}, '', '/products/lamp');
    const root = render(window, config(), 'AbCdEfGhIjKl')!;
    expect(root.querySelector('.greeting')!.textContent).toBe('Questions about this product?');
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/checkout/');
    expect(render(window, config(), 'AbCdEfGhIjKl')).toBeNull();
    expect(document.querySelector('[data-wbm-chat-button]')).toBeNull();
  });

  it('opens the rule\'s link with w and p from Start chat, and Escape closes the greeting', () => {
    window.history.replaceState({}, '', '/products/lamp?color=red');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const root = render(window, config(), 'AbCdEfGhIjKl')!;
    const card = root.querySelector<HTMLElement>('.card')!;
    root.querySelector<HTMLButtonElement>('.open')!.click();
    expect(card.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('.start')!.click();
    expect(open).toHaveBeenCalledWith('https://go.example.com/c/ProductsXy?w=AbCdEfGhIjKl&p=%2Fproducts%2Flamp', '_blank', 'noopener');
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.hidden).toBe(true);
    expect(startLink('https://go.example.com/c/X?a=1', 'K', '/p')).toBe('https://go.example.com/c/X?a=1&w=K&p=%2Fp');
  });

  it('does nothing and throws nothing for hidden buttons, bad keys and fetch errors', async () => {
    const fetchHidden = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hidden: true }) });
    Object.assign(window, { fetch: fetchHidden });
    await expect(boot(window, script({ src: 'https://go.example.com/w/widget.js', 'data-key': 'AbCdEfGhIjKl' }))).resolves.toBeNull();
    expect(fetchHidden).toHaveBeenCalledWith('https://go.example.com/w/AbCdEfGhIjKl/config.json', { credentials: 'omit' });
    delete (window as unknown as { __wbmChatButton?: boolean }).__wbmChatButton;
    Object.assign(window, { fetch: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(boot(window, script({ src: 'https://go.example.com/w/widget.js', 'data-key': 'AbCdEfGhIjKl' }))).resolves.toBeNull();
    delete (window as unknown as { __wbmChatButton?: boolean }).__wbmChatButton;
    await expect(boot(window, script({ src: 'https://go.example.com/w/widget.js', 'data-key': 'short' }))).resolves.toBeNull();
    expect(document.querySelector('[data-wbm-chat-button]')).toBeNull();
  });

  it('runs once per page, and draws an inline preview config without fetching', async () => {
    const fetch = vi.fn();
    Object.assign(window, { fetch });
    const root = await boot(window, script({ src: 'https://go.example.com/w/widget.js', 'data-preview': JSON.stringify(config()) }));
    expect(root).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await expect(boot(window, script({ src: 'https://go.example.com/w/widget.js', 'data-preview': JSON.stringify(config()) }))).resolves.toBeNull();
    expect(document.querySelectorAll('[data-wbm-chat-button]')).toHaveLength(1);
  });
});
