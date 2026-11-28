import { Injectable, Logger } from '@nestjs/common';
import type { MetaTemplateComponent } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { normalizePhone } from '../../../common/phone/phone.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { Prisma, type AdLead, type AdLeadForm } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { VariableMappingSchema, resolveVariables, unmappedVariables, type VariableMapping } from '../../campaigns/variable-resolver.js';
import { ConsentService } from '../../contacts/consent.service.js';
import { DripEvents } from '../../growth/drips/drip-events.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { SettingsService } from '../../settings/settings.service.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { sendJobId } from '../../sending/dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from '../../sending/send-outcome.js';
import { headerMediaType } from '../../sending/template-payload.builder.js';
import { AdsConnectionService, type AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient, type MetaLead } from '../meta-ads.client.js';
import { leadSourceFor } from '../../contacts/lead-source.js';
import { AutoTagService } from '../../contacts/auto-tags.service.js';

// Lead forms and leads (feature 007 US7, FR-035 – FR-039, research R9): forms made at Meta with the
// page token and a WhatsApp consent checkbox; each lead becomes a contact with the form's tag, is opted
// in (source LEAD_FORM) only when the checkbox was ticked, and then gets the form's welcome template
// once through the 001 send queue. Leads are recorded once (Meta's lead id is unique).

/** The custom disclaimer checkbox key given to Meta, read back from each lead. */
export const CONSENT_KEY = 'whatsapp_consent';
const STANDARD = ['FULL_NAME', 'PHONE', 'EMAIL'] as const;
const META_QUESTION = { FULL_NAME: 'FULL_NAME', PHONE: 'PHONE', EMAIL: 'EMAIL' } as const;

export const LeadFormInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    questions: z
      .object({
        standard: z.array(z.enum(STANDARD)).min(1).max(3),
        custom: z
          .array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'use lowercase letters, digits and _'), label: z.string().trim().min(1).max(80) }).strict())
          .max(3)
          .optional(),
      })
      .strict(),
    privacyUrl: z
      .string()
      .trim()
      .max(2000)
      .regex(/^https:\/\//, 'must start with https://'),
    consentText: z.string().trim().min(10).max(300),
    tagId: z.uuid().nullish(),
    welcomeTemplateId: z.uuid().nullish(),
    welcomeMapping: VariableMappingSchema.optional(),
  })
  .strict();
export type LeadFormInput = z.infer<typeof LeadFormInputSchema>;

export const LeadsQuerySchema = z
  .object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

@Injectable()
export class AdLeadFormsService {
  private readonly logger = new Logger(AdLeadFormsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly consent: ConsentService,
    private readonly journey: JourneyService,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
    private readonly audit: AuditService,
    private readonly queues: QueueRegistry,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
    private readonly autoTags: AutoTagService,
  ) {}

  async list() {
    const rows = await this.prisma.adLeadForm.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    const counts = await this.prisma.adLead.groupBy({ by: ['formId'], where: { formId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    return rows.map((r) => this.dto(r, counts.find((c) => c.formId === r.id)?._count._all ?? 0));
  }

  async get(id: string) {
    const row = await this.find(id);
    return this.dto(row, await this.prisma.adLead.count({ where: { formId: id } }));
  }

  /** Made at Meta first (the page must accept the lead terms), then saved; the page is subscribed to leads. */
  async create(input: LeadFormInput, actor: AuditActor & { userId: string }) {
    const problems = await this.problems(input);
    if (problems.length) throw AppError.validation('Check the lead form', problems);
    if (await this.prisma.adLeadForm.findUnique({ where: { name: input.name }, select: { id: true } })) throw AppError.conflict('A lead form with this name exists', 'NAME_TAKEN');
    const access = await this.connection.requireUsable();
    const checks = ((access.row.checks ?? {}) as { checks?: Array<{ check: string; result: string }> }).checks ?? [];
    const terms = checks.find((c) => c.check === 'LEAD_TERMS');
    if (terms && terms.result !== 'PASSED') throw AppError.conflict("Accept Meta's lead ads terms for the page first, then run the connection checks again", 'TERMS_NOT_ACCEPTED');
    const pageToken = this.pageToken(access);
    const questions = [
      ...input.questions.standard.map((q) => ({ type: META_QUESTION[q] })),
      ...(input.questions.custom ?? []).map((q) => ({ type: 'CUSTOM', key: q.key, label: q.label })),
    ];
    let metaFormId: string;
    try {
      metaFormId = await this.ads.createLeadForm(pageToken, access.row.pageId, { name: input.name, questions, privacyUrl: input.privacyUrl, privacyText: 'Privacy policy', consentText: input.consentText });
      await this.ads.subscribePageToLeads(pageToken, access.row.pageId);
    } catch (error) {
      if (error instanceof MetaApiError) throw AppError.validation(`Meta refused the form: ${error.message}`, [], 'META_REFUSED');
      throw error;
    }
    let row: AdLeadForm;
    try {
      row = await this.prisma.adLeadForm.create({
        data: {
          name: input.name,
          questions: input.questions as Prisma.InputJsonValue,
          privacyUrl: input.privacyUrl,
          consentText: input.consentText,
          tagId: input.tagId ?? null,
          welcomeTemplateId: input.welcomeTemplateId ?? null,
          welcomeMapping: (input.welcomeMapping ?? {}) as Prisma.InputJsonValue,
          metaFormId,
          createdById: actor.userId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A lead form with this name exists', 'NAME_TAKEN');
      throw error;
    }
    await this.audit.record(actor, 'ad_lead_form.created', { type: 'ad_lead_form', id: row.id }, { name: row.name, metaFormId });
    return this.dto(row, 0);
  }

  /** The tag and welcome message can change here; Meta's form cannot change after it is used. */
  async update(id: string, input: Pick<LeadFormInput, 'tagId' | 'welcomeTemplateId' | 'welcomeMapping'>) {
    const row = await this.find(id);
    const merged = { ...input, welcomeTemplateId: input.welcomeTemplateId === undefined ? row.welcomeTemplateId : input.welcomeTemplateId, welcomeMapping: input.welcomeMapping ?? (row.welcomeMapping as VariableMapping) };
    const problems = await this.references(merged);
    if (problems.length) throw AppError.validation('Check the lead form', problems);
    const updated = await this.prisma.adLeadForm.update({
      where: { id },
      data: {
        ...(input.tagId !== undefined ? { tagId: input.tagId } : {}),
        ...(input.welcomeTemplateId !== undefined ? { welcomeTemplateId: input.welcomeTemplateId } : {}),
        ...(input.welcomeMapping !== undefined ? { welcomeMapping: input.welcomeMapping as Prisma.InputJsonValue } : {}),
      },
    });
    return this.dto(updated, await this.prisma.adLead.count({ where: { formId: id } }));
  }

  async leads(id: string, query: z.infer<typeof LeadsQuerySchema>) {
    await this.find(id);
    const [total, rows] = await Promise.all([
      this.prisma.adLead.count({ where: { formId: id } }),
      this.prisma.adLead.findMany({ where: { formId: id }, orderBy: { submittedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return {
      total,
      items: rows.map((l) => ({
        id: l.id,
        // The phone is shown in `phone` (masked without phones.full), not in the answers.
        answers: Object.fromEntries(Object.entries((l.answers ?? {}) as Record<string, string>).filter(([key]) => key !== 'phone_number')),
        phone: l.phoneE164,
        email: l.email,
        consent: l.consent,
        status: l.status,
        contactId: l.contactId,
        submittedAt: l.submittedAt.toISOString(),
      })),
    };
  }

  /** Every lead of a form, newest first, in pages (for the CSV export). */
  async *exportRows(id: string, batch = 1000): AsyncGenerator<AdLead[]> {
    await this.find(id);
    let cursor: string | null = null;
    for (;;) {
      const rows: AdLead[] = await this.prisma.adLead.findMany({
        where: { formId: id },
        orderBy: { id: 'asc' },
        take: batch,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!rows.length) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < batch) return;
    }
  }

  /** One lead from Meta (webhook or catch-up): recorded once, then the contact, tag, consent and welcome. */
  async ingest(lead: MetaLead, now = new Date()): Promise<'NEW' | 'KNOWN' | 'UNKNOWN_FORM'> {
    if (await this.prisma.adLead.findUnique({ where: { metaLeadId: lead.id }, select: { id: true } })) return 'KNOWN';
    const form = lead.formId ? await this.prisma.adLeadForm.findUnique({ where: { metaFormId: lead.formId } }) : null;
    if (!form) {
      this.metrics.adLeadsTotal.inc({ result: 'unknown_form' });
      return 'UNKNOWN_FORM';
    }
    const campaign = lead.adId
      ? await this.prisma.adVersion.findUnique({ where: { metaAdId: lead.adId }, select: { adCampaign: { select: { id: true, name: true } } } })
      : null;
    const { defaultCountryCode } = await this.settings.get();
    const rawPhone = lead.fields.phone_number?.trim() ?? '';
    const phone = rawPhone ? normalizePhone(rawPhone, defaultCountryCode) : null;
    const status = !rawPhone ? 'NO_PHONE' : phone ? 'PROCESSED' : 'INVALID_PHONE';
    const consent = lead.disclaimers[CONSENT_KEY] === true;
    const name = (lead.fields.full_name ?? '').trim().slice(0, 120) || null;
    const submittedAt = Number.isNaN(Date.parse(lead.createdTime)) ? now : new Date(lead.createdTime.replace(/\+0000$/, 'Z'));

    let created: { leadId: string; contactId: string | null } | null;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        let contactId: string | null = null;
        if (phone) {
          const known = await tx.contact.findUnique({ where: { phoneE164: phone.e164 }, select: { id: true } });
          const contact = await tx.contact.upsert({
            where: { phoneE164: phone.e164 },
            create: { phoneE164: phone.e164, countryCode: phone.country, name, ...leadSourceFor('LEAD_FORM', form.name) },
            update: {},
            select: { id: true },
          });
          contactId = contact.id;
          // Automatic tags for a contact this lead created (feature 010, R4).
          if (!known) await this.autoTags.apply(tx, 'CONTACT_CREATED', contact.id, 'LEAD_FORM');
          if (form.tagId) {
            const added = await tx.contactTag.createManyAndReturn({ data: [{ contactId, tagId: form.tagId }], skipDuplicates: true, select: { contactId: true, tagId: true } });
            if (added.length) {
              await this.dripEvents.recordTagAddedToMany(tx, added);
              await this.platformEvents.tagLinksChanged(tx, added);
            }
          }
        }
        const row = await tx.adLead.create({
          data: {
            formId: form.id,
            metaLeadId: lead.id,
            metaAdId: lead.adId,
            adCampaignId: campaign?.adCampaign.id ?? null,
            answers: lead.fields as Prisma.InputJsonValue,
            phoneE164: phone?.e164 ?? null,
            email: lead.fields.email?.slice(0, 320) ?? null,
            consent,
            contactId,
            status,
            submittedAt,
            receivedAt: now,
          },
        });
        await tx.adLeadForm.update({ where: { id: form.id }, data: { lastLeadAt: now } });
        await this.platformEvents.adLeadReceived(tx, {
          contactId,
          form: { id: form.id, name: form.name },
          campaign: campaign?.adCampaign ?? null,
          metaLeadId: lead.id,
          consent,
          status,
        });
        return { leadId: row.id, contactId };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'KNOWN';
      throw error;
    }
    if (created.contactId) {
      // An opt-in only from the ticked WhatsApp checkbox (FR-037).
      if (consent) await this.consent.setStatus(created.contactId, 'OPTED_IN', 'LEAD_FORM', { note: `Lead form "${form.name}"` });
      await this.journey.recordForContact(created.contactId, { type: 'LEAD_RECEIVED', actorType: 'CUSTOMER', data: { formId: form.id, formName: form.name, consent, adCampaignName: campaign?.adCampaign.name ?? null } });
      if (consent && form.welcomeTemplateId) await this.welcome(form, created.leadId, created.contactId, lead);
    }
    this.metrics.adLeadsTotal.inc({ result: status.toLowerCase() });
    return 'NEW';
  }

  /** The welcome template, once per lead, from a connected number of the template's account; never to opted-out contacts. */
  private async welcome(form: AdLeadForm, leadId: string, contactId: string, lead: MetaLead): Promise<void> {
    const [template, contact] = await Promise.all([
      this.prisma.template.findUnique({ where: { id: form.welcomeTemplateId! }, select: { id: true, wabaId: true, status: true, variables: true } }),
      this.prisma.contact.findUnique({ where: { id: contactId }, select: { name: true, phoneE164: true, countryCode: true, attributes: true, consentStatus: true, blockedAt: true } }),
    ]);
    if (!template || template.status !== 'APPROVED' || !contact || contact.consentStatus !== 'OPTED_IN' || contact.blockedAt) return;
    const number = await this.prisma.whatsAppNumber.findFirst({ where: { wabaId: template.wabaId, connectionStatus: 'CONNECTED', sendingEnabled: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!number) {
      this.logger.warn({ formId: form.id }, 'No connected number can send the lead form welcome template');
      return;
    }
    const resolved = resolveVariables((template.variables ?? []) as Array<{ key: string }>, (form.welcomeMapping ?? {}) as VariableMapping, {
      contact: { name: contact.name, phone: contact.phoneE164, attributes: contact.attributes },
      row: lead.fields,
    });
    if (!resolved.ok) {
      this.logger.warn({ formId: form.id, missing: resolved.missing }, 'Lead form welcome template has unmapped variables');
      return;
    }
    const now = new Date();
    let messageId: string;
    try {
      messageId = await this.prisma.$transaction(async (tx) => {
        if (await tx.message.findFirst({ where: { adLeadId: leadId }, select: { id: true } })) throw new SkipWelcome();
        const message = await tx.message.create({
          data: {
            origin: 'ADS',
            adLeadId: leadId,
            contactId,
            phoneE164: contact.phoneE164,
            recipientCountry: contact.countryCode,
            numberId: number.id,
            templateId: template.id,
            resolvedParams: resolved.params as Prisma.InputJsonValue,
            status: 'QUEUED',
            queuedAt: now,
          },
        });
        await tx.messageEvent.create({ data: { messageId: message.id, type: 'QUEUED', occurredAt: now, dedupeKey: `${message.id}:queued` } });
        return message.id;
      });
    } catch (error) {
      if (error instanceof SkipWelcome) return;
      throw error;
    }
    try {
      await this.queues
        .sendQueue(number.id)
        .add('send', { messageId }, { jobId: sendJobId(messageId), attempts: MAX_SEND_ATTEMPTS, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } });
    } catch (error) {
      this.logger.error({ err: error, messageId }, 'Could not queue a lead form welcome message');
      await this.prisma.message.updateMany({ where: { id: messageId, status: 'QUEUED' }, data: { status: 'FAILED', failureReason: 'queue_unavailable', failedAt: new Date() } });
    }
  }

  /** The page token makes forms and reads leads (pages_manage_ads, leads_retrieval). */
  pageToken(access: AdsAccess): string {
    if (!access.pageToken) throw AppError.conflict('The connection has no page token; connect the page again in Ads > Connect', 'CONNECTION_ERROR');
    return access.pageToken;
  }

  async find(id: string): Promise<AdLeadForm> {
    const row = await this.prisma.adLeadForm.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Lead form not found');
    return row;
  }

  private async problems(input: LeadFormInput) {
    const problems: Array<{ field: string; issue: string }> = [];
    if (!/whatsapp/i.test(input.consentText)) problems.push({ field: 'consentText', issue: 'must name WhatsApp, so people know what they agree to' });
    if (!input.questions.standard.includes('PHONE')) problems.push({ field: 'questions.standard', issue: 'must ask for the phone number' });
    if (new Set(input.questions.standard).size !== input.questions.standard.length) problems.push({ field: 'questions.standard', issue: 'must not repeat a question' });
    const keys = (input.questions.custom ?? []).map((q) => q.key);
    if (new Set(keys).size !== keys.length) problems.push({ field: 'questions.custom', issue: 'keys must be different' });
    problems.push(...(await this.references(input)));
    return problems;
  }

  private async references(input: Pick<LeadFormInput, 'tagId' | 'welcomeTemplateId' | 'welcomeMapping'>) {
    const problems: Array<{ field: string; issue: string }> = [];
    if (input.tagId && !(await this.prisma.tag.findUnique({ where: { id: input.tagId }, select: { id: true } }))) problems.push({ field: 'tagId', issue: 'is not a tag' });
    if (input.welcomeTemplateId) {
      const template = await this.prisma.template.findUnique({ where: { id: input.welcomeTemplateId }, select: { status: true, variables: true, components: true } });
      if (!template) problems.push({ field: 'welcomeTemplateId', issue: 'is not a template' });
      else if (template.status !== 'APPROVED') problems.push({ field: 'welcomeTemplateId', issue: 'is not approved by Meta' });
      else if (headerMediaType((template.components ?? []) as unknown as MetaTemplateComponent[])) problems.push({ field: 'welcomeTemplateId', issue: 'has a media header; choose a template without one' });
      else {
        const missing = unmappedVariables((template.variables ?? []) as Array<{ key: string }>, input.welcomeMapping ?? {});
        if (missing.length) problems.push({ field: 'welcomeMapping', issue: `needs a value for ${missing.join(', ')}` });
      }
    }
    return problems;
  }

  private dto(r: AdLeadForm, leads: number) {
    return {
      id: r.id,
      name: r.name,
      questions: r.questions,
      privacyUrl: r.privacyUrl,
      consentText: r.consentText,
      tagId: r.tagId,
      welcomeTemplateId: r.welcomeTemplateId,
      welcomeMapping: r.welcomeMapping,
      metaFormId: r.metaFormId,
      leads,
      lastLeadAt: r.lastLeadAt?.toISOString() ?? null,
    };
  }
}

class SkipWelcome extends Error {}
