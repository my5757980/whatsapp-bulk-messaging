// Feature 009 (contracts/meta-templates.md, research R2, R6 - R8): Meta's documented rules for the create
// and send bodies of authentication, carousel and limited-time offer templates. The api checks its own
// Meta bodies with them before calling Meta; the test fakes (FakeTemplatesGraph, mock-meta) answer like
// Meta with them. Each function returns Meta-style problem text, or null.
import { TEMPLATE_LIMITS, TTL_RANGES } from '../template-rules.js';

type Json = Record<string, unknown>;

const upper = (value: unknown) => (typeof value === 'string' ? value.toUpperCase() : '');
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Json[]) : []);
const chars = (value: unknown) => (typeof value === 'string' ? [...value].length : 0);
const byType = (components: unknown, type: string) => asArray(components).filter((c) => upper(c.type) === type);

export type MetaTemplateKind = 'STANDARD' | 'CAROUSEL' | 'LIMITED_TIME_OFFER' | 'AUTHENTICATION';

/** The kind of a template from Meta's components and category. */
export function metaKindOf(category: unknown, components: unknown): MetaTemplateKind {
  if (upper(category) === 'AUTHENTICATION') return 'AUTHENTICATION';
  if (byType(components, 'CAROUSEL').length) return 'CAROUSEL';
  if (byType(components, 'LIMITED_TIME_OFFER').length) return 'LIMITED_TIME_OFFER';
  return 'STANDARD';
}

/** Problems with a `POST /{waba}/message_templates` body (only the 009 kinds and the TTL are checked). */
export function metaCreateProblem(body: { category?: unknown; components?: unknown; message_send_ttl_seconds?: unknown }): string | null {
  const category = upper(body.category);
  const ttl = body.message_send_ttl_seconds;
  if (ttl !== undefined && ttl !== null) {
    if (category === 'MARKETING') return 'message_send_ttl_seconds is supported for marketing templates only through the Marketing Messages API';
    const [min, max] = TTL_RANGES[category === 'AUTHENTICATION' ? 'AUTHENTICATION' : 'UTILITY'];
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || (ttl !== -1 && (ttl < min || ttl > max))) return `message_send_ttl_seconds must be between ${min} and ${max}, or -1`;
  }
  const kind = metaKindOf(body.category, body.components);
  if (kind === 'AUTHENTICATION') return authCreateProblem(body.components);
  if (kind === 'CAROUSEL') return category === 'MARKETING' ? carouselCreateProblem(body.components) : 'Carousel templates must be MARKETING';
  if (kind === 'LIMITED_TIME_OFFER') return category === 'MARKETING' ? offerCreateProblem(body.components) : 'Limited-time offer templates must be MARKETING';
  return null;
}

function authCreateProblem(components: unknown): string | null {
  const list = asArray(components);
  if (list.some((c) => upper(c.type) === 'HEADER')) return 'Authentication templates do not support a header';
  const bodies = byType(list, 'BODY');
  if (bodies.length !== 1) return 'Authentication templates need one BODY component';
  if (bodies[0]!.text !== undefined) return 'The body text of authentication templates is set by WhatsApp';
  const footer = byType(list, 'FOOTER')[0];
  if (footer) {
    const minutes = footer.code_expiration_minutes;
    if (typeof minutes !== 'number' || minutes < TEMPLATE_LIMITS.codeExpiryMinutesMin || minutes > TEMPLATE_LIMITS.codeExpiryMinutesMax) return 'code_expiration_minutes must be between 1 and 90';
  }
  const buttons = asArray(byType(list, 'BUTTONS')[0]?.buttons);
  if (buttons.length !== 1 || upper(buttons[0]!.type) !== 'OTP') return 'Authentication templates need one OTP button';
  const button = buttons[0]!;
  const otpType = upper(button.otp_type);
  if (otpType !== 'COPY_CODE' && otpType !== 'ONE_TAP') return 'otp_type must be COPY_CODE or ONE_TAP';
  if (button.text !== undefined && chars(button.text) > TEMPLATE_LIMITS.buttonTextMax) return 'Button text must be at most 25 characters';
  if (otpType === 'ONE_TAP') {
    if (button.autofill_text !== undefined && chars(button.autofill_text) > TEMPLATE_LIMITS.buttonTextMax) return 'autofill_text must be at most 25 characters';
    const apps = asArray(button.supported_apps);
    if (apps.length < 1 || apps.length > TEMPLATE_LIMITS.otpAppsMax) return 'supported_apps needs 1 to 5 apps';
    for (const app of apps) {
      if (typeof app.package_name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(app.package_name) || app.package_name.length > TEMPLATE_LIMITS.packageNameMax) return 'Invalid package_name';
      if (typeof app.signature_hash !== 'string' || !/^[A-Za-z0-9+/=]{11}$/.test(app.signature_hash)) return 'signature_hash must be exactly 11 characters';
    }
  }
  return null;
}

function carouselCreateProblem(components: unknown): string | null {
  const list = asArray(components);
  if (list.some((c) => ['HEADER', 'FOOTER', 'BUTTONS'].includes(upper(c.type)))) return 'A carousel template has only a BODY and a CAROUSEL component';
  const body = byType(list, 'BODY')[0];
  if (!body || chars(body.text) < 1 || chars(body.text) > TEMPLATE_LIMITS.bodyMax) return 'The message body must have 1 to 1024 characters';
  const cards = asArray(byType(list, 'CAROUSEL')[0]?.cards);
  if (cards.length < TEMPLATE_LIMITS.carouselCardsMin || cards.length > TEMPLATE_LIMITS.carouselCardsMax) return 'A carousel needs 2 to 10 cards';
  const shape = (card: Json) =>
    asArray(card.components)
      .map((c) => (upper(c.type) === 'BUTTONS' ? `BUTTONS:${asArray(c.buttons).map((b) => upper(b.type)).join(',')}` : upper(c.type) === 'HEADER' ? `HEADER:${upper(c.format)}` : upper(c.type)))
      .join('|');
  const first = shape(cards[0]!);
  for (const card of cards) {
    const parts = asArray(card.components);
    const header = parts.find((c) => upper(c.type) === 'HEADER');
    if (!header || (upper(header.format) !== 'IMAGE' && upper(header.format) !== 'VIDEO')) return 'Each card needs an IMAGE or VIDEO header';
    const handle = (header.example as Json | undefined)?.header_handle;
    if (!Array.isArray(handle) || !handle.length) return 'Each card header needs example.header_handle';
    const cardBody = parts.find((c) => upper(c.type) === 'BODY');
    if (cardBody && chars(cardBody.text) > TEMPLATE_LIMITS.cardBodyMax) return 'Card body text must be at most 160 characters';
    const buttons = asArray(parts.find((c) => upper(c.type) === 'BUTTONS')?.buttons);
    if (buttons.length > TEMPLATE_LIMITS.cardButtonsMax) return 'A card has at most 2 buttons';
    if (buttons.some((b) => !['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(upper(b.type)))) return 'Card buttons must be QUICK_REPLY, URL or PHONE_NUMBER';
    if (shape(card) !== first) return 'All cards must have the same components';
  }
  return null;
}

function offerCreateProblem(components: unknown): string | null {
  const list = asArray(components);
  if (list.some((c) => upper(c.type) === 'FOOTER')) return 'Footer components are not supported';
  const header = byType(list, 'HEADER')[0];
  if (header && upper(header.format) !== 'IMAGE' && upper(header.format) !== 'VIDEO') return 'The header must be IMAGE or VIDEO';
  const offer = (byType(list, 'LIMITED_TIME_OFFER')[0]?.limited_time_offer ?? {}) as Json;
  if (chars(offer.text) < 1 || chars(offer.text) > TEMPLATE_LIMITS.offerTextMax) return 'limited_time_offer.text must have 1 to 16 characters';
  const body = byType(list, 'BODY')[0];
  if (!body || chars(body.text) < 1 || chars(body.text) > TEMPLATE_LIMITS.offerBodyMax) return 'The body must have 1 to 600 characters';
  const buttons = asArray(byType(list, 'BUTTONS')[0]?.buttons);
  const copy = buttons.find((b) => upper(b.type) === 'COPY_CODE');
  if (!copy || chars(copy.example) < 1 || chars(copy.example) > TEMPLATE_LIMITS.offerCodeMax) return 'A COPY_CODE button with an example of up to 15 characters is required';
  if (buttons.filter((b) => upper(b.type) === 'URL').length !== 1) return 'One URL button is required';
  return null;
}

/** Meta's stored form of created components: authentication OTP buttons come back as URL. */
export function metaStoredComponents(category: unknown, components: unknown): unknown[] {
  if (upper(category) !== 'AUTHENTICATION') return asArray(components);
  return asArray(components).map((c) =>
    upper(c.type) === 'BUTTONS' ? { ...c, buttons: asArray(c.buttons).map((b) => (upper(b.type) === 'OTP' ? { ...b, type: 'URL' } : b)) } : c,
  );
}

/** Problems with the components of a template send, for the 009 kinds (null for standard ones). */
export function metaSendProblem(template: { category: unknown; components: unknown }, sendComponents: unknown): string | null {
  const kind = metaKindOf(template.category, template.components);
  const sent = asArray(sendComponents);
  if (kind === 'AUTHENTICATION') {
    const code = asArray(byType(sent, 'BODY')[0]?.parameters)[0]?.text;
    if (typeof code !== 'string' || chars(code) < 1 || chars(code) > 15) return 'The one-time password must have 1 to 15 characters';
    const button = sent.find((c) => upper(c.type) === 'BUTTON' && upper(c.sub_type) === 'URL' && String(c.index) === '0');
    if (asArray(button?.parameters)[0]?.text !== code) return 'The one-time password must appear in the body and in the button parameter';
    return null;
  }
  if (kind === 'CAROUSEL') {
    const templateCards = asArray(byType(template.components, 'CAROUSEL')[0]?.cards);
    const cards = asArray(byType(sent, 'CAROUSEL')[0]?.cards);
    if (cards.length !== templateCards.length) return `The template has ${templateCards.length} cards; send every card`;
    for (const [i, card] of cards.entries()) {
      if (card.card_index !== i) return 'card_index must count from 0 in order';
      const header = asArray(card.components).find((c) => upper(c.type) === 'HEADER');
      const param = asArray(header?.parameters)[0];
      const media = param ? ((param[String(param.type)] as Json | undefined) ?? {}) : {};
      if (!param || (param.type !== 'image' && param.type !== 'video') || typeof media.id !== 'string') return `Card ${i} needs its header media id`;
    }
    return null;
  }
  if (kind === 'LIMITED_TIME_OFFER') {
    const offer = asArray(byType(sent, 'LIMITED_TIME_OFFER')[0]?.parameters)[0];
    const ms = (offer?.limited_time_offer as Json | undefined)?.expiration_time_ms;
    const showsEnd = Boolean(((byType(template.components, 'LIMITED_TIME_OFFER')[0]?.limited_time_offer ?? {}) as Json).has_expiration);
    if (showsEnd && (typeof ms !== 'number' || !Number.isInteger(ms) || ms <= 0)) return 'limited_time_offer.expiration_time_ms is required';
    const copy = sent.find((c) => upper(c.type) === 'BUTTON' && upper(c.sub_type) === 'COPY_CODE');
    const coupon = asArray(copy?.parameters)[0];
    if (coupon?.type !== 'coupon_code' || chars(coupon.coupon_code) < 1 || chars(coupon.coupon_code) > TEMPLATE_LIMITS.offerCodeMax) return 'The copy_code button needs a coupon_code of 1 to 15 characters';
    return null;
  }
  return null;
}
