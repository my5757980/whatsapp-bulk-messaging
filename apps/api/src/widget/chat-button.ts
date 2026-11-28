// Feature 009 (research R15, contracts/website-button.md): the website chat button. Plain ES2019 in an
// IIFE (scripts/build-widget.mjs bundles the shared page rule matcher), one global guard, no cookies or
// storage, nothing thrown to the page. Everything is drawn inside a closed shadow root.
import { pageKey, pickPageRule, type PageRuleLike } from '@wbm/shared/page-rules';

export interface WidgetLook {
  colour: string;
  buttonText: string;
  corner: 'BOTTOM_LEFT' | 'BOTTOM_RIGHT';
  offsetX: number;
  offsetY: number;
  radius: number;
}

export interface WidgetRule extends PageRuleLike {
  id: string;
  greeting?: string | null;
  startUrl?: string | null;
}

export interface WidgetConfig {
  hidden: false;
  version: string;
  look: WidgetLook;
  brandName: string;
  brandImageUrl?: string | null;
  greeting: string;
  startUrl: string;
  rules: WidgetRule[];
}

type Fetched = WidgetConfig | { hidden: true };

const KEY = /^[A-Za-z0-9]{12}$/;
// Our own chat-bubble icon (not a brand logo).
const ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.66 15l-1.3 4.77 4.9-1.29A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-2.9.76.78-2.83-.2-.31A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.25-.13-1.46-.72-1.69-.8-.23-.08-.39-.13-.55.12-.16.25-.63.8-.78.97-.14.17-.29.19-.53.06a6.7 6.7 0 0 1-3.3-2.88c-.25-.43.25-.4.71-1.33.08-.16.04-.3-.02-.42-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47a.9.9 0 0 0-.65.3 2.74 2.74 0 0 0-.86 2.04 4.76 4.76 0 0 0 1 2.53 10.9 10.9 0 0 0 4.18 3.7c1.56.67 2.17.73 2.95.61.47-.07 1.46-.6 1.66-1.18.2-.58.2-1.07.14-1.18-.06-.1-.22-.16-.47-.29Z"/></svg>';

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const safeColour = (value: string) => (/^#[0-9A-Fa-f]{6}$/.test(value) ? value : '#25D366');
const clamp = (value: number, max: number) => (Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : 0);

/** Where Start chat goes: the rule's (or default) chat link with the button key and the page path. */
export function startLink(startUrl: string, key: string, path: string): string {
  const join = startUrl.includes('?') ? '&' : '?';
  return `${startUrl}${join}w=${encodeURIComponent(key)}&p=${encodeURIComponent(path.slice(0, 200))}`;
}

/** Draws the button for a config; returns the shadow root (for tests), or null when nothing shows. */
export function render(win: Window, config: WidgetConfig, key: string): ShadowRoot | null {
  const doc = win.document;
  const page = pageKey(win.location.pathname, win.location.search);
  const rule = pickPageRule(config.rules ?? [], page);
  if (rule?.hide) return null;
  const look = config.look;
  const side = look.corner === 'BOTTOM_LEFT' ? 'left' : 'right';
  const host = doc.createElement('div');
  host.setAttribute('data-wbm-chat-button', '');
  const root = host.attachShadow({ mode: 'closed' });
  const colour = safeColour(look.colour);
  const radius = clamp(look.radius, 40);
  root.innerHTML = `
<style>
  :host { all: initial; }
  .wrap { position: fixed; ${side}: ${clamp(look.offsetX, 200)}px; bottom: ${clamp(look.offsetY, 200)}px; z-index: 2147483000; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .open { display: inline-flex; align-items: center; gap: 8px; border: 0; cursor: pointer; color: #fff; background: ${colour}; border-radius: ${radius}px; padding: 12px 16px; font-size: 15px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .card { position: absolute; ${side}: 0; bottom: 60px; width: 290px; max-width: calc(100vw - 32px); background: #fff; color: #111; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.25); padding: 16px; box-sizing: border-box; }
  .card[hidden] { display: none; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; margin-bottom: 8px; }
  .brand img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
  .greeting { margin: 0 0 12px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; }
  .start { width: 100%; border: 0; cursor: pointer; color: #fff; background: ${colour}; border-radius: 8px; padding: 10px; font-size: 15px; }
  .close { position: absolute; top: 6px; right: 8px; border: 0; background: none; cursor: pointer; font-size: 18px; color: #555; }
</style>
<div class="wrap">
  <div class="card" role="dialog" aria-modal="false" aria-labelledby="wbm-brand" hidden>
    <button type="button" class="close" aria-label="Close">&times;</button>
    <div class="brand">${config.brandImageUrl ? `<img src="${esc(config.brandImageUrl)}" alt="">` : ''}<span id="wbm-brand">${esc(config.brandName)}</span></div>
    <p class="greeting">${esc(rule?.greeting || config.greeting)}</p>
    <button type="button" class="start">Start chat</button>
  </div>
  <button type="button" class="open" aria-haspopup="dialog" aria-expanded="false">${ICON}<span>${esc(look.buttonText || 'Chat with us')}</span></button>
</div>`;
  const card = root.querySelector<HTMLElement>('.card')!;
  const open = root.querySelector<HTMLButtonElement>('.open')!;
  const start = root.querySelector<HTMLButtonElement>('.start')!;
  const toggle = (show: boolean) => {
    card.hidden = !show;
    open.setAttribute('aria-expanded', String(show));
    if (show) start.focus();
    else open.focus();
  };
  open.addEventListener('click', () => toggle(Boolean(card.hidden)));
  root.querySelector<HTMLButtonElement>('.close')!.addEventListener('click', () => toggle(false));
  card.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') toggle(false);
  });
  start.addEventListener('click', () => {
    const url = startLink(rule?.startUrl || config.startUrl, key, win.location.pathname);
    // Phones open WhatsApp in the same tab; computers in a new one.
    const phone = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
    if (phone) win.location.href = url;
    else win.open(url, '_blank', 'noopener');
  });
  (doc.body ?? doc.documentElement).appendChild(host);
  return root;
}

/** Reads the script tag, fetches the config (or reads the inline preview) and draws the button. */
export async function boot(win: Window, script: HTMLScriptElement | null): Promise<ShadowRoot | null> {
  try {
    if (!script) return null;
    const guard = win as unknown as { __wbmChatButton?: boolean };
    if (guard.__wbmChatButton) return null;
    guard.__wbmChatButton = true;
    const key = script.getAttribute('data-key') ?? '';
    const preview = script.getAttribute('data-preview');
    let config: Fetched;
    if (preview) {
      config = JSON.parse(preview) as Fetched;
    } else {
      if (!KEY.test(key)) return null;
      const base = script.src.replace(/\/w\/widget\.js(?:[?#].*)?$/, '');
      const res = await win.fetch(`${base}/w/${key}/config.json`, { credentials: 'omit' });
      if (!res.ok) return null;
      config = (await res.json()) as Fetched;
    }
    if (!config || config.hidden) return null;
    return render(win, config, key || 'preview00000');
  } catch {
    // Never break the page.
    return null;
  }
}

if (typeof document !== 'undefined' && document.currentScript) void boot(window, document.currentScript as HTMLScriptElement);
