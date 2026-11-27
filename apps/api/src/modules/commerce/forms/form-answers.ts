import { Injectable, Logger } from '@nestjs/common';
import { FormModelSchema, formFields, type FormField } from '@wbm/shared';
import { normalizePhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { ConsentService } from '../../contacts/consent.service.js';
import { ContactsService } from '../../contacts/contacts.service.js';
import { DripEvents } from '../../growth/drips/drip-events.js';
import type { FormAnswersPort, InboundFormReply } from '../../inbox/inbound/form-answers.port.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { SettingsService } from '../../settings/settings.service.js';
import { FormTokens } from './form-tokens.js';

// Answers to WhatsApp Forms (feature 008 US7, FR-034, FR-035, research R12): trusted only when the
// flow_token is ours, unchanged and names this contact. Each answer is checked by its field type
// (an invalid value is kept with a problem), mapped attributes are set by their attribute type, the
// version's tags are added, a ticked opt-in field opts the contact in with source FORM, and the
// journey and the form.submitted event are written.

const SOURCE: Record<string, string> = { chat: 'INBOX', session: 'FLOW', message: 'TEMPLATE', recipient: 'CAMPAIGN' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Problem = { fieldKey: string; reason: string };

@Injectable()
export class FormAnswersService implements FormAnswersPort {
  private readonly logger = new Logger(FormAnswersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: FormTokens,
    private readonly contacts: ContactsService,
    private readonly consent: ConsentService,
    private readonly journey: JourneyService,
    private readonly events: PlatformEvents,
    private readonly dripEvents: DripEvents,
    private readonly settings: SettingsService,
  ) {}

  async received(reply: InboundFormReply): Promise<boolean> {
    const response = (reply.payload.response ?? {}) as Record<string, unknown>;
    if (typeof response !== 'object' || response === null) return false;
    const token = this.tokens.decode(response.flow_token);
    if (!token || token.contactId !== reply.contactId) return false;
    const version = await this.prisma.formVersion.findUnique({ where: { id: token.versionId }, include: { form: { select: { id: true, name: true } } } });
    if (!version) return false;
    const model = FormModelSchema.safeParse(version.model);
    if (!model.success) return false;

    const fields = formFields(model.data).map((f) => f.field);
    const answers: Record<string, unknown> = {};
    const problems: Problem[] = [];
    const { defaultCountryCode } = await this.settings.get();
    for (const field of fields) {
      const raw = response[field.key];
      if (raw === undefined || raw === null || raw === '') {
        if (field.required && field.type !== 'optIn') problems.push({ fieldKey: field.key, reason: 'missing' });
        continue;
      }
      const { value, problem } = this.check(field, raw, defaultCountryCode);
      answers[field.key] = value;
      if (problem) problems.push({ fieldKey: field.key, reason: problem });
    }

    // Mapped attributes, set by their attribute type; values that do not fit are problems, not errors.
    const mapping = (Array.isArray(version.mapping) ? version.mapping : []) as Array<{ fieldKey: string; attributeKey: string }>;
    const saved: Record<string, unknown> = {};
    const definitions = await this.prisma.attributeDefinition.findMany({ where: { key: { in: mapping.map((m) => m.attributeKey) } } });
    for (const m of mapping) {
      const definition = definitions.find((d) => d.key === m.attributeKey);
      const value = answers[m.fieldKey];
      if (!definition || value === undefined || problems.some((p) => p.fieldKey === m.fieldKey)) continue;
      const typed = this.asAttribute(definition.type, value);
      if (typed === undefined) problems.push({ fieldKey: m.fieldKey, reason: `does not fit the ${definition.type.toLowerCase()} attribute ${definition.key}` });
      else saved[definition.key] = typed;
    }
    if (Object.keys(saved).length) {
      const contact = await this.prisma.contact.findUnique({ where: { id: reply.contactId }, select: { attributes: true } });
      try {
        await this.contacts.update(reply.contactId, { attributes: { ...((contact?.attributes ?? {}) as Record<string, unknown>), ...saved } as never }, null);
      } catch (error) {
        this.logger.warn({ contactId: reply.contactId, err: error }, 'Form answer attributes were not saved');
        for (const key of Object.keys(saved)) problems.push({ fieldKey: mapping.find((m) => m.attributeKey === key)?.fieldKey ?? key, reason: 'the attribute could not be saved' });
      }
    }

    const optedIn = fields.some((f) => f.type === 'optIn' && answers[f.key] === true);
    const answer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.formAnswer.create({
        data: {
          formId: version.formId,
          formVersionId: version.id,
          contactId: reply.contactId,
          conversationId: reply.conversationId,
          chatItemId: reply.chatItemId,
          source: SOURCE[token.ref] ?? 'INBOX',
          flowSessionId: token.ref === 'session' ? token.refId : null,
          answers: answers as Prisma.InputJsonValue,
          saved: saved as Prisma.InputJsonValue,
          problems: problems as unknown as Prisma.InputJsonValue,
        },
      });
      if (version.tagIds.length) {
        const added = await tx.contactTag.createManyAndReturn({ data: version.tagIds.map((tagId) => ({ contactId: reply.contactId, tagId })), skipDuplicates: true, select: { contactId: true, tagId: true } });
        if (added.length) {
          await this.dripEvents.recordTagAddedToMany(tx, added);
          await this.events.tagLinksChanged(tx, added);
        }
      }
      await tx.chatMessage.update({ where: { id: reply.chatItemId }, data: { payload: { ...reply.payload, formAnswerId: created.id, formName: version.form.name } as Prisma.InputJsonValue } });
      await this.events.formSubmitted(tx, { form: { id: version.formId, name: version.form.name, version: version.number }, answers, contactId: reply.contactId, answerId: created.id });
      return created;
    });
    if (optedIn) {
      const contact = await this.prisma.contact.findUnique({ where: { id: reply.contactId }, select: { consentStatus: true } });
      if (contact && contact.consentStatus !== 'OPTED_IN') await this.consent.setStatus(reply.contactId, 'OPTED_IN', 'FORM', { note: `Ticked the opt-in of the form "${version.form.name}"`.slice(0, 500) });
    }
    await this.journey.recordForContact(reply.contactId, { type: 'FORM_SUBMITTED', actorType: 'CUSTOMER', data: { form: version.form.name, formAnswerId: answer.id, problems: problems.length } });
    return true;
  }

  /** An answer by its field type: the value to keep, and a problem when it does not fit. */
  private check(field: FormField, raw: unknown, country: string): { value: unknown; problem?: string } {
    const text = typeof raw === 'string' ? raw.trim() : raw;
    switch (field.type) {
      case 'email':
        return EMAIL.test(String(text)) ? { value: String(text).toLowerCase() } : { value: text, problem: 'not an email address' };
      case 'phone': {
        const phone = normalizePhone(String(text), country);
        return phone ? { value: phone.e164 } : { value: text, problem: 'not a phone number' };
      }
      case 'number': {
        const n = typeof text === 'number' ? text : Number(text);
        return Number.isFinite(n) ? { value: n } : { value: text, problem: 'not a number' };
      }
      case 'date':
        return DATE.test(String(text)) ? { value: String(text) } : { value: text, problem: 'not a date' };
      case 'optIn':
        return { value: text === true || text === 'true' };
      case 'singleChoice':
      case 'dropdown': {
        const ids = new Set((field.options ?? []).map((o) => o.id));
        return ids.has(String(text)) ? { value: String(text) } : { value: text, problem: 'not one of the options' };
      }
      case 'multipleChoice': {
        const ids = new Set((field.options ?? []).map((o) => o.id));
        const list = Array.isArray(text) ? text.map(String) : [String(text)];
        return list.every((id) => ids.has(id)) ? { value: list } : { value: list, problem: 'not one of the options' };
      }
      default:
        return { value: String(text).slice(0, 4000) };
    }
  }

  /** A value for an attribute of this type, or undefined when it does not fit. */
  private asAttribute(type: string, value: unknown): unknown {
    switch (type) {
      case 'NUMBER': {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) ? n : undefined;
      }
      case 'DATE':
        return typeof value === 'string' && DATE.test(value) ? value : undefined;
      case 'BOOLEAN':
        return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;
      default:
        return Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
}
