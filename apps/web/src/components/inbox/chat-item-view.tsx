'use client';

import { formatMinor } from '@wbm/shared';
import type { AiItemPayload, ChatItem, ChatItemStatus } from '@/lib/inbox-types';
import { cn } from '@/lib/utils';
import { ChatOrderCard } from './chat-order-card';
import { PaymentCard } from './payment-card';

const mediaUrl = (id: string) => `/api/inbox/media/${id}`;
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function time(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** Ticks for messages we sent: clock while queued, one tick sent, two delivered, two blue read. */
export function Ticks({ status }: { status: ChatItemStatus | null }) {
  if (!status) return null;
  const label: Record<ChatItemStatus, string> = {
    QUEUED: 'Queued',
    SENDING: 'Sending',
    SENT: 'Sent',
    DELIVERED: 'Delivered',
    READ: 'Read',
    FAILED: 'Failed',
  };
  const symbol = status === 'QUEUED' || status === 'SENDING' ? '🕓' : status === 'SENT' ? '✓' : status === 'FAILED' ? '⚠' : '✓✓';
  return (
    <span title={label[status]} aria-label={label[status]} className={cn('ml-1 text-xs', status === 'READ' && 'text-sky-600', status === 'FAILED' && 'text-destructive')}>
      {symbol}
    </span>
  );
}

function MediaBody({ item }: { item: ChatItem }) {
  const media = item.media;
  if (!media) return null;
  if (media.state === 'PENDING') return <p className="text-xs italic text-muted-foreground">Downloading…</p>;
  if (media.state === 'FAILED' || !media.id) return <p className="text-xs italic text-muted-foreground">Media unavailable</p>;
  const src = mediaUrl(media.id);
  switch (item.contentType) {
    case 'IMAGE':
    case 'STICKER':
      return (
        <a href={src} target="_blank" rel="noreferrer">
          {/* A plain img: the file comes from the authenticated API, not a static asset. */}
          <img src={src} alt={item.contentType === 'STICKER' ? 'Sticker' : (item.text ?? 'Picture')} className={cn('rounded-md', item.contentType === 'STICKER' ? 'h-28 w-28 object-contain' : 'max-h-72 max-w-full')} />
        </a>
      );
    case 'VIDEO':
      return <video src={src} controls preload="metadata" className="max-h-72 max-w-full rounded-md" />;
    case 'AUDIO':
      return <audio src={src} controls preload="metadata" className="w-60" />;
    default:
      return (
        <a href={src} className="text-sm underline" download={media.fileName ?? undefined}>
          📄 {media.fileName ?? 'Download file'}
        </a>
      );
  }
}

/** The AI agent (feature 004, with "test" for draft replies) or chatbot flow (feature 003) that sent an automatic message. */
function automationName(item: ChatItem): string | null {
  // Drip steps (feature 005, FR-033) name the drip and the step.
  if (item.drip) return `Drip "${item.drip.name}" · step ${item.drip.step}`;
  const ai = item.payload.ai;
  if (ai && typeof ai === 'object' && typeof (ai as { agentName?: unknown }).agentName === 'string') {
    const { agentName, test } = ai as { agentName: string; test?: unknown };
    return test === true ? `${agentName} · test` : agentName;
  }
  const flow = item.payload.flow;
  return flow && typeof flow === 'object' && typeof (flow as { flowName?: unknown }).flowName === 'string' ? (flow as { flowName: string }).flowName : null;
}

const SOURCE_KINDS: Record<string, string> = { ANSWER: 'Written answer', WEBSITE: 'Website', FILE: 'File' };

/** The knowledge and skills an AI reply used (004 FR-020), folded away under the message. */
function AiUsed({ item }: { item: ChatItem }) {
  const ai = item.payload.ai as Partial<AiItemPayload> | undefined;
  if (!ai || typeof ai !== 'object') return null;
  const sources = Array.isArray(ai.sources) ? ai.sources : [];
  const skills = Array.isArray(ai.skills) ? ai.skills : [];
  if (!sources.length && !skills.length) return null;
  const counts = [
    sources.length ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}` : null,
    skills.length ? `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}` : null,
  ].filter(Boolean);
  return (
    <details className="mt-1 text-[11px] text-muted-foreground" data-testid="ai-used">
      <summary className="cursor-pointer select-none">Used {counts.join(' and ')}</summary>
      <ul className="mt-1 grid gap-0.5">
        {sources.map((source) => (
          <li key={source.id}>
            {SOURCE_KINDS[source.kind] ?? source.kind}: {source.title}
          </li>
        ))}
        {skills.map((skill, i) => (
          <li key={`${skill.skillId}:${i}`}>
            Skill: {skill.name} ({skill.outcome})
          </li>
        ))}
      </ul>
    </details>
  );
}

function Body({ item }: { item: ChatItem }) {
  const p = item.payload;
  switch (item.contentType) {
    case 'TEXT':
      return <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>;
    case 'IMAGE':
    case 'VIDEO':
    case 'AUDIO':
    case 'DOCUMENT':
    case 'STICKER':
      return (
        <div className="grid gap-1">
          <MediaBody item={item} />
          {item.contentType === 'AUDIO' && p.voice === true && <span className="text-xs text-muted-foreground">Voice message</span>}
          {item.text && <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>}
        </div>
      );
    case 'LOCATION': {
      const lat = Number(p.latitude);
      const lng = Number(p.longitude);
      return (
        <a className="text-sm underline" href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer">
          📍 {str(p.name) ?? 'Shared location'}
          {str(p.address) ? ` — ${str(p.address)}` : ''}
        </a>
      );
    }
    case 'CONTACTS': {
      const cards = Array.isArray(p.contacts) ? (p.contacts as Array<{ name?: string; phones?: string[] }>) : [];
      return (
        <div className="grid gap-1 text-sm">
          {cards.map((card, i) => (
            <div key={i}>
              👤 {card.name ?? 'Contact'} {card.phones?.length ? <span className="text-muted-foreground">({card.phones.join(', ')})</span> : null}
            </div>
          ))}
        </div>
      );
    }
    case 'BUTTON_REPLY':
    case 'LIST_REPLY':
      return (
        <p className="text-sm">
          <span className="text-muted-foreground">Chose: </span>
          {str(p.title) ?? item.text}
          {str(p.description) ? <span className="text-muted-foreground"> — {str(p.description)}</span> : null}
        </p>
      );
    case 'FORM_REPLY': {
      // Answers to our forms (feature 008 US7) are saved; the others are shown as they came.
      const response = { ...((p.response ?? {}) as Record<string, unknown>) };
      delete response.flow_token;
      return (
        <div className="grid gap-1 text-sm" data-testid="form-reply">
          {str(p.formName) ? <p className="text-xs text-muted-foreground">Answer to {str(p.formName)}</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            {Object.entries(response).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="font-mono text-muted-foreground">{key}</dt>
                <dd className="break-words">{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    }
    // A WhatsApp Form we sent (feature 008 US7).
    case 'FORM':
      return (
        <div className="grid gap-1 text-sm" data-testid="form-message">
          {str(p.header) && <p className="font-medium">{str(p.header)}</p>}
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
          <span className="rounded border bg-background px-2 py-1 text-center text-xs">📝 {str(p.cta) ?? 'Open form'}</span>
          {str(p.formName) ? <span className="text-xs text-muted-foreground">Form {str(p.formName)}</span> : null}
        </div>
      );
    case 'REACTION':
      return <p className="text-sm">{str(p.emoji) ? `Reacted ${String(p.emoji)} to a message` : 'Removed a reaction'}</p>;
    case 'BUTTONS':
    case 'LIST': {
      // A chatbot flow's reply buttons or list (feature 003); the customer taps one in WhatsApp.
      const options =
        item.contentType === 'BUTTONS'
          ? (Array.isArray(p.buttons) ? (p.buttons as Array<{ title?: string }>) : [])
          : (Array.isArray(p.sections) ? (p.sections as Array<{ rows?: Array<{ title?: string }> }>) : []).flatMap((s) => s.rows ?? []);
      return (
        <div className="grid gap-1 text-sm">
          {str(p.header) && <p className="font-medium">{str(p.header)}</p>}
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
          {str(p.footer) && <p className="text-xs text-muted-foreground">{str(p.footer)}</p>}
          <ul className="mt-1 grid gap-1" aria-label={item.contentType === 'BUTTONS' ? 'Reply buttons' : 'List options'}>
            {item.contentType === 'LIST' && str(p.buttonLabel) && <li className="text-xs text-muted-foreground">☰ {str(p.buttonLabel)}</li>}
            {options.map((option, i) => (
              <li key={i} className="rounded border bg-background px-2 py-1 text-center text-xs">
                {option.title}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    // A cart sent in chat (feature 008 US6).
    case 'ORDER':
      return str(p.chatOrderId) ? <ChatOrderCard orderId={String(p.chatOrderId)} /> : <p className="text-sm">🛒 Cart sent</p>;
    // Product messages (feature 008 US5): one product, a product list or the catalog.
    case 'PRODUCT':
    case 'PRODUCT_LIST':
    case 'CATALOG': {
      const products = (Array.isArray(p.products) ? p.products : []) as Array<{ retailerId?: string; name?: string; priceMinor?: number | null; currency?: string | null; imageUrl?: string | null }>;
      return (
        <div className="grid gap-1 text-sm" data-testid={`product-message-${item.contentType}`}>
          {str(p.header) && <p className="font-medium">{str(p.header)}</p>}
          {item.text ? <p className="whitespace-pre-wrap break-words">{item.text}</p> : null}
          {item.contentType === 'CATALOG' ? <p className="text-xs text-muted-foreground">🛍 View catalog</p> : null}
          <ul className="grid gap-1" aria-label="Products">
            {products.map((product, i) => (
              <li key={product.retailerId ?? i} className="flex items-center gap-2 rounded border bg-background px-2 py-1 text-xs">
                {product.imageUrl ? <img src={product.imageUrl} alt="" className="size-8 rounded object-cover" /> : null}
                <span className="flex-1">{product.name ?? product.retailerId}</span>
                {typeof product.priceMinor === 'number' && product.currency ? <span>{formatMinor(product.priceMinor, product.currency)}</span> : null}
              </li>
            ))}
          </ul>
          {str(p.footer) && <p className="text-xs text-muted-foreground">{str(p.footer)}</p>}
        </div>
      );
    }
    // The Pay now message (feature 008 US2).
    case 'PAYMENT_REQUEST':
      return (
        <div className="grid gap-1 text-sm">
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
          {item.payment ? <PaymentCard payment={item.payment} /> : null}
        </div>
      );
    case 'TEMPLATE':
      return (
        <div className="grid gap-1 text-sm">
          <p className="whitespace-pre-wrap break-words">{item.template?.renderedText}</p>
          {item.payment ? <PaymentCard payment={item.payment} /> : null}
          <span className="text-xs text-muted-foreground">
            Template {item.template?.name}
            {item.campaign ? ` · Campaign "${item.campaign.name}"` : item.origin === 'API' ? ' · API' : ''}
          </span>
        </div>
      );
    default:
      return <p className="text-sm italic text-muted-foreground">This message type is not supported on the web; open it on the phone.</p>;
  }
}

/** A Click-to-WhatsApp referral kept on the customer's message (feature 007 US3). */
function adReferral(value: unknown): { metaAdId: string; headline: string | null } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { metaAdId, headline } = value as { metaAdId?: unknown; headline?: unknown };
  return typeof metaAdId === 'string' ? { metaAdId, headline: typeof headline === 'string' ? headline : null } : null;
}

/** One timeline entry; customer messages on the left, ours on the right. */
export function ChatItemView({ item }: { item: ChatItem }) {
  const ours = item.kind !== 'INBOUND';
  const referral = adReferral(item.payload?.referral);
  return (
    <div className={cn('flex', ours ? 'justify-end' : 'justify-start')} data-testid="chat-item" data-kind={item.kind}>
      <div
        className={cn(
          'max-w-[78%] rounded-lg px-3 py-2 shadow-sm',
          ours ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-card border',
          item.kind === 'NOTE' && 'border border-dashed border-amber-400 bg-amber-50 dark:bg-amber-950',
        )}
      >
        {referral ? (
          <p className="mb-1 text-[11px] text-sky-700 dark:text-sky-300" data-testid="ad-referral">
            From the ad: {referral.headline ?? referral.metaAdId}
          </p>
        ) : null}
        <Body item={item} />
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {item.kind === 'NOTE' && <span className="font-medium text-amber-700 dark:text-amber-300">Internal note ·</span>}
          {item.sentBy && <span>{item.sentBy.name} ·</span>}
          {item.origin === 'AUTOMATIC' && <span>{automationName(item) ? `Automatic · ${automationName(item)} ·` : 'Automatic ·'}</span>}
          <span>{time(item.occurredAt)}</span>
          {ours && item.kind !== 'NOTE' && <Ticks status={item.status} />}
        </div>
        <AiUsed item={item} />
        {item.firstClickAt ? (
          <p className="mt-1 text-right text-[11px] text-emerald-700 dark:text-emerald-300" data-testid="link-opened">
            Link opened {time(item.firstClickAt)}
          </p>
        ) : null}
        {item.status === 'FAILED' && item.failureReason && <p className="mt-1 text-xs text-destructive">Not sent: {item.failureReason}</p>}
      </div>
    </div>
  );
}
