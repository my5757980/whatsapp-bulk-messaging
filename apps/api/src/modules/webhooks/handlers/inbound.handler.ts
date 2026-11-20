import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConsentStatus } from '@wbm/shared';
import type { Redis } from 'ioredis';
import { normalizePhone, waIdToE164 } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { ConsentService } from '../../contacts/consent.service.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { WebhookRouter, type WebhookChange, type WebhookChangeHandler } from '../webhook-router.js';

const DEDUPE_TTL_SECONDS = 7 * 24 * 3600;

/** Normalises inbound text for keyword matching: trim, collapse whitespace, uppercase (R12). */
export function normalizeKeyword(text: string | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function messageText(message: Record<string, unknown>): string | undefined {
  const field = (key: string) => (message[key] && typeof message[key] === 'object' ? (message[key] as Record<string, unknown>) : undefined);
  switch (message.type) {
    case 'text':
      return str(field('text')?.body);
    case 'button':
      return str(field('button')?.text);
    case 'interactive': {
      const interactive = field('interactive');
      const reply = (interactive?.button_reply ?? interactive?.list_reply) as Record<string, unknown> | undefined;
      return str(reply?.title);
    }
    default:
      return undefined;
  }
}

/**
 * Inbound customer messages (T102, contracts/meta-webhooks.md §4): exact keyword matches change
 * consent with source KEYWORD; unknown senders become contacts. Only the consent outcome is
 * stored, not the message content. Each message id is processed once (`id:inbound`).
 */
@Injectable()
export class InboundHandler implements WebhookChangeHandler, OnModuleInit {
  readonly field = 'messages';

  constructor(
    private readonly router: WebhookRouter,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly consent: ConsentService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly journey: JourneyService,
  ) {}

  onModuleInit(): void {
    this.router.register(this);
  }

  async handle(change: WebhookChange): Promise<void> {
    const messages = Array.isArray(change.value.messages) ? (change.value.messages as Array<Record<string, unknown>>) : [];
    if (!messages.length) return;
    const profiles = new Map<string, string>();
    for (const c of Array.isArray(change.value.contacts) ? (change.value.contacts as Array<Record<string, unknown>>) : []) {
      const name = str((c.profile as Record<string, unknown> | undefined)?.name);
      const waId = str(c.wa_id);
      if (waId && name) profiles.set(waId, name);
    }
    for (const message of messages) await this.handleOne(message, profiles);
  }

  private async handleOne(message: Record<string, unknown>, profiles: Map<string, string>): Promise<void> {
    const id = str(message.id);
    const from = str(message.from);
    if (!id || !from) return;
    const dedupeKey = `wbm:inbound:${id}:inbound`;
    if (await this.redis.exists(dedupeKey)) return;

    const settings = await this.settings.get();
    const phone = normalizePhone(waIdToE164(from), settings.defaultCountryCode);
    if (phone) {
      const keyword = normalizeKeyword(messageText(message));
      const status: ConsentStatus | null = settings.optOutKeywords.includes(keyword)
        ? 'OPTED_OUT'
        : settings.optInKeywords.includes(keyword)
          ? 'OPTED_IN'
          : null;
      const contact = await this.prisma.contact.upsert({
        where: { phoneE164: phone.e164 },
        // A contact first seen through their own message came organically (002 FR-033).
        create: { phoneE164: phone.e164, countryCode: phone.country, name: profiles.get(from)?.slice(0, 120) ?? null, leadSource: 'Organic' },
        update: {},
        select: { id: true },
      });
      if (status) {
        const before = await this.prisma.contact.findUnique({ where: { id: contact.id }, select: { consentStatus: true } });
        await this.consent.setStatus(contact.id, status, 'KEYWORD', { note: `Replied "${keyword}"` });
        // Live chat journey (002 T070); only real changes are recorded.
        if (before?.consentStatus !== status) await this.journey.consentChanged(contact.id, status, 'KEYWORD');
      }
    }
    await this.redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS);
  }
}
