import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { FORM_CATEGORIES, FormModelSchema, can, compileFlowJson, formChecks, formFields, permissionsFor, type FormModel, type FormProblem } from '@wbm/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import type { Form, FormVersion, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import { isLive } from '../../inbox/conversations/window.js';
import { SessionSendService } from '../../inbox/messages/session-send.service.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { NumbersService } from '../../numbers/numbers.service.js';
import { MetaCommerceClient, type FlowValidationError } from '../meta-commerce.client.js';
import { FormTokens } from './form-tokens.js';

// WhatsApp Forms (feature 008 US7, FR-030 – FR-034, research R12, contracts/commerce-api.openapi.yaml tag
// forms): drafts checked by the shared rules, published as numbered versions to every WhatsApp account
// (Meta's validation errors mapped back to screens and fields), archived (their Meta flows deprecated),
// sent in the 24-hour window with a signed token, and their answers listed and exported.

export const CreateFormSchema = z.object({ name: z.string().trim().min(1).max(80), category: z.enum(FORM_CATEGORIES) }).strict();
export const SaveFormSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    category: z.enum(FORM_CATEGORIES),
    draft: FormModelSchema,
    mapping: z.array(z.object({ fieldKey: z.string().min(1).max(40), attributeKey: z.string().min(1).max(60) }).strict()).max(50),
    tagIds: z.array(z.uuid()).max(20),
  })
  .strict();
export const ListFormsSchema = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional() }).strict();
export const AnswersQuerySchema = z
  .object({ versionId: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();
export const SendFormSchema = z
  .object({ formId: z.uuid(), header: z.string().trim().max(60).optional(), body: z.string().trim().min(1).max(1024), cta: z.string().trim().min(1).max(30) })
  .strict();

type MetaFlow = { wabaId: string; flowId: string | null; status: string; errors?: FlowValidationError[] };

function versionDto(v: FormVersion) {
  const flows = (Array.isArray(v.metaFlows) ? v.metaFlows : []) as unknown as MetaFlow[];
  return { id: v.id, number: v.number, status: v.status, accounts: flows.map((f) => ({ wabaId: f.wabaId, status: f.status })), publishedAt: v.publishedAt.toISOString() };
}

const emptyModel = (): FormModel => ({ screens: [] }) as unknown as FormModel;

@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaCommerceClient,
    private readonly numbers: NumbersService,
    private readonly audit: AuditService,
    private readonly tokens: FormTokens,
    private readonly sessions: SessionSendService,
  ) {}

  private async summary(form: Form, versions?: FormVersion[]) {
    const all = versions ?? (await this.prisma.formVersion.findMany({ where: { formId: form.id }, orderBy: { number: 'desc' } }));
    const current = all.find((v) => v.id === form.currentVersionId);
    return {
      id: form.id,
      name: form.name,
      category: form.category,
      status: form.status,
      changedSincePublish: form.changedSincePublish,
      currentVersion: current?.number ?? null,
      answers: await this.prisma.formAnswer.count({ where: { formId: form.id } }),
    };
  }

  private async dto(form: Form) {
    const versions = await this.prisma.formVersion.findMany({ where: { formId: form.id }, orderBy: { number: 'desc' } });
    const parsed = FormModelSchema.safeParse(form.draft);
    return {
      ...(await this.summary(form, versions)),
      draft: parsed.success ? parsed.data : (form.draft as unknown as FormModel) ?? emptyModel(),
      mapping: (Array.isArray(form.mapping) ? form.mapping : []) as Array<{ fieldKey: string; attributeKey: string }>,
      tagIds: form.tagIds,
      versions: versions.map(versionDto),
    };
  }

  private async row(id: string): Promise<Form> {
    const form = await this.prisma.form.findUnique({ where: { id } });
    if (!form) throw AppError.notFound('Form not found');
    return form;
  }

  async list(status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | undefined, user: RequestUser) {
    const manager = can(user.role, 'forms.manage');
    const forms = await this.prisma.form.findMany({ where: manager ? (status ? { status } : {}) : { status: 'PUBLISHED' }, orderBy: { updatedAt: 'desc' } });
    return { items: await Promise.all(forms.map((f) => this.summary(f))) };
  }

  async get(id: string) {
    return this.dto(await this.row(id));
  }

  async create(input: z.infer<typeof CreateFormSchema>, actor: AuditActor) {
    try {
      const form = await this.prisma.form.create({ data: { name: input.name, category: input.category, createdById: actor.userId ?? null } });
      return this.dto(form);
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A form with this name already exists', 'NAME_TAKEN');
      throw error;
    }
  }

  async save(id: string, input: z.infer<typeof SaveFormSchema>, actor: AuditActor) {
    const form = await this.row(id);
    if (form.status === 'ARCHIVED') throw AppError.conflict('An archived form cannot be changed', 'ARCHIVED');
    const keys = new Set(formFields(input.draft).map((f) => f.field.key));
    const details = input.mapping.filter((m) => !keys.has(m.fieldKey)).map((m) => ({ field: `mapping.${m.fieldKey}`, issue: 'is not a field of the form' }));
    const attributes = await this.prisma.attributeDefinition.findMany({ where: { key: { in: input.mapping.map((m) => m.attributeKey) } }, select: { key: true } });
    for (const m of input.mapping) if (!attributes.some((a) => a.key === m.attributeKey)) details.push({ field: `mapping.${m.fieldKey}`, issue: `the attribute ${m.attributeKey} does not exist` });
    const tags = await this.prisma.tag.count({ where: { id: { in: input.tagIds } } });
    if (tags !== new Set(input.tagIds).size) details.push({ field: 'tagIds', issue: 'a tag does not exist' });
    if (details.length) throw AppError.validation('Request failed validation', details);
    try {
      const updated = await this.prisma.form.update({
        where: { id },
        data: {
          name: input.name,
          category: input.category,
          draft: input.draft as unknown as Prisma.InputJsonValue,
          mapping: input.mapping as Prisma.InputJsonValue,
          tagIds: [...new Set(input.tagIds)],
          changedSincePublish: true,
          updatedById: actor.userId ?? null,
        },
      });
      return this.dto(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A form with this name already exists', 'NAME_TAKEN');
      throw error;
    }
  }

  /** The shared checks plus the mapping (FR-031). */
  async check(id: string): Promise<{ problems: FormProblem[] }> {
    const form = await this.row(id);
    const parsed = FormModelSchema.safeParse(form.draft);
    if (!parsed.success) return { problems: [{ screen: null, fieldKey: null, message: 'Add at least one screen' }] };
    return { problems: formChecks(parsed.data) };
  }

  /** Publishes the draft as version n+1 to every WhatsApp account; nothing is saved when Meta refuses. */
  async publish(id: string, actor: AuditActor) {
    const form = await this.row(id);
    if (form.status === 'ARCHIVED') throw AppError.conflict('An archived form cannot be published', 'ARCHIVED');
    if (form.currentVersionId && !form.changedSincePublish) throw AppError.conflict('Nothing changed since the last version', 'NO_CHANGES');
    const parsed = FormModelSchema.safeParse(form.draft);
    const problems = parsed.success ? formChecks(parsed.data) : [{ screen: null, fieldKey: null, message: 'Add at least one screen' }];
    if (!parsed.success || problems.length) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'FORM_PROBLEMS', 'Fix the problems before publishing', problems.map((p) => ({ field: p.fieldKey ?? (p.screen !== null ? `screen ${p.screen + 1}` : 'form'), issue: p.message })));
    }
    const flowJson = compileFlowJson(parsed.data);
    const last = await this.prisma.formVersion.findFirst({ where: { formId: id }, orderBy: { number: 'desc' }, select: { number: true } });
    const number = (last?.number ?? 0) + 1;
    const numbers = await this.prisma.whatsAppNumber.findMany({ where: { connectionStatus: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
    const byWaba = new Map<string, (typeof numbers)[number]>();
    for (const n of numbers) if (!byWaba.has(n.wabaId)) byWaba.set(n.wabaId, n);
    if (!byWaba.size) throw AppError.conflict('Connect a WhatsApp number first', 'NUMBER_NO_FORM');
    const flows: MetaFlow[] = [];
    const refused: Array<{ field: string; issue: string }> = [];
    for (const [wabaId, n] of byWaba) {
      try {
        // Meta flow names are unique per account; a retry after a refusal needs a new one.
        const name = `${form.name} v${number} ${Date.now().toString(36).slice(-5)}`.slice(0, 200);
        const created = await this.graph.createFlow(this.numbers.token(n), wabaId, { name, categories: [form.category], flowJson, publish: true });
        flows.push({ wabaId, flowId: created.id, status: created.validationErrors.length ? 'FAILED' : 'PUBLISHED', errors: created.validationErrors });
        for (const e of created.validationErrors) refused.push({ field: this.pointer(e, parsed.data), issue: e.message });
      } catch (error) {
        const message = error instanceof MetaApiError ? error.message : 'Meta could not be reached';
        flows.push({ wabaId, flowId: null, status: 'FAILED' });
        refused.push({ field: 'form', issue: message });
      }
    }
    if (refused.length) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'META_REFUSED', 'Meta refused the form', refused.slice(0, 50));
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await tx.formVersion.create({
        data: {
          formId: id,
          number,
          model: parsed.data as unknown as Prisma.InputJsonValue,
          mapping: form.mapping as Prisma.InputJsonValue,
          tagIds: form.tagIds,
          flowJson: flowJson as unknown as Prisma.InputJsonValue,
          metaFlows: flows as unknown as Prisma.InputJsonValue,
          publishedById: actor.userId ?? null,
        },
      });
      await tx.form.update({ where: { id }, data: { status: 'PUBLISHED', currentVersionId: created.id, changedSincePublish: false } });
      return created;
    });
    await this.audit.record(actor, 'form.published', { type: 'form', id }, { version: number, accounts: flows.length });
    return versionDto(version);
  }

  /** "screens[1].fields[0]"-style pointers back to "screen 2" or the field key. */
  private pointer(error: FlowValidationError, model: FormModel): string {
    for (const p of error.pointers) {
      const screen = /S(\d+)/.exec(p)?.[1];
      const field = formFields(model).find((f) => p.includes(f.field.key));
      if (field) return field.field.key;
      if (screen) return `screen ${screen}`;
    }
    return 'form';
  }

  async archive(id: string, actor: AuditActor) {
    const form = await this.row(id);
    if (form.status === 'ARCHIVED') return this.dto(form);
    const inUse = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT f.id FROM flows f JOIN flow_versions v ON v.id = f.published_version_id
       WHERE f.deleted_at IS NULL AND v.graph::text LIKE ${`%${id}%`} LIMIT 1`;
    if (inUse.length) throw AppError.conflict('A published flow sends this form; change the flow first', 'IN_USE');
    const versions = await this.prisma.formVersion.findMany({ where: { formId: id, status: 'PUBLISHED' } });
    for (const v of versions) {
      for (const f of (Array.isArray(v.metaFlows) ? v.metaFlows : []) as unknown as MetaFlow[]) {
        if (!f.flowId) continue;
        const number = await this.prisma.whatsAppNumber.findFirst({ where: { wabaId: f.wabaId, connectionStatus: 'CONNECTED' } });
        if (number) await this.graph.deprecateFlow(this.numbers.token(number), f.flowId).catch(() => undefined);
      }
    }
    await this.prisma.formVersion.updateMany({ where: { formId: id, status: 'PUBLISHED' }, data: { status: 'DEPRECATED' } });
    const updated = await this.prisma.form.update({ where: { id }, data: { status: 'ARCHIVED' } });
    await this.audit.record(actor, 'form.archived', { type: 'form', id }, { versions: versions.length });
    return this.dto(updated);
  }

  async remove(id: string): Promise<void> {
    const form = await this.row(id);
    if (form.currentVersionId || (await this.prisma.formVersion.count({ where: { formId: id } }))) throw AppError.conflict('A published form is archived, not deleted', 'PUBLISHED_USE_ARCHIVE');
    await this.prisma.form.delete({ where: { id } });
  }

  async answers(id: string, query: z.infer<typeof AnswersQuerySchema>, user: RequestUser) {
    await this.row(id);
    const where: Prisma.FormAnswerWhereInput = { formId: id, ...(query.versionId ? { formVersionId: query.versionId } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.formAnswer.findMany({ where, include: { formVersion: { select: { number: true } }, contact: { select: { name: true, phoneE164: true } } }, orderBy: { submittedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.formAnswer.count({ where }),
    ]);
    const full = can(user.role, 'phones.full');
    return {
      total,
      items: rows.map((a) => ({
        id: a.id,
        versionNumber: a.formVersion.number,
        contactId: a.contactId,
        contactName: a.contact.name,
        phone: full ? a.contact.phoneE164 : maskPhone(a.contact.phoneE164),
        source: a.source,
        answers: a.answers,
        problems: a.problems,
        submittedAt: a.submittedAt.toISOString(),
      })),
    };
  }

  async exportAnswers(id: string, user: RequestUser, req: AuthedRequest, res: Response): Promise<void> {
    const form = await this.row(id);
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'form_answers.exported', { type: 'form', id }, { format: 'csv' });
    const current = form.currentVersionId ? await this.prisma.formVersion.findUnique({ where: { id: form.currentVersionId } }) : null;
    const model = FormModelSchema.safeParse(current?.model ?? form.draft);
    const keys = model.success ? formFields(model.data).map((f) => f.field.key) : [];
    const full = can(user.role, 'phones.full');
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="form-${form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'answers'}.csv"`);
    res.write(`${['submitted_at', 'version', 'name', 'phone', 'source', ...keys, 'problems'].map(csvField).join(',')}\n`);
    let cursor: string | null = null;
    for (;;) {
      const page: Array<Prisma.FormAnswerGetPayload<{ include: { formVersion: { select: { number: true } }; contact: { select: { name: true; phoneE164: true } } } }>> = await this.prisma.formAnswer.findMany({
        where: { formId: id, ...(cursor ? { id: { gt: cursor } } : {}) },
        include: { formVersion: { select: { number: true } }, contact: { select: { name: true, phoneE164: true } } },
        orderBy: { id: 'asc' },
        take: 1000,
      });
      if (!page.length) break;
      cursor = page[page.length - 1]!.id;
      const chunk = page
        .map((a) => {
          const answers = (a.answers ?? {}) as Record<string, unknown>;
          const values = keys.map((k) => (Array.isArray(answers[k]) ? (answers[k] as unknown[]).join('; ') : String(answers[k] ?? '')));
          const problems = ((Array.isArray(a.problems) ? a.problems : []) as Array<{ fieldKey: string; reason: string }>).map((p) => `${p.fieldKey}: ${p.reason}`).join('; ');
          return [a.submittedAt.toISOString(), String(a.formVersion.number), a.contact.name ?? '', full ? a.contact.phoneE164 : (maskPhone(a.contact.phoneE164) ?? ''), a.source, ...values, problems].map(csvField).join(',');
        })
        .join('\n');
      if (!res.write(`${chunk}\n`)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }

  /** POST /inbox/conversations/{id}/forms (FR-033): a published form in the window, with a signed token. */
  async send(user: RequestUser, conversationId: string, input: z.infer<typeof SendFormSchema>) {
    const viewer = { id: user.id, role: user.role, permissions: new Set<string>(permissionsFor(user.role)) };
    const chat = await this.sessions.prepare(viewer, conversationId, { requireWindow: false });
    if (!isLive(chat.lastCustomerMessageAt)) throw AppError.conflict('The 24-hour reply window has closed. Use a template with a form button instead.', 'WINDOW_CLOSED');
    const form = await this.row(input.formId);
    const version = form.status === 'PUBLISHED' && form.currentVersionId ? await this.prisma.formVersion.findUnique({ where: { id: form.currentVersionId } }) : null;
    if (!version) throw AppError.conflict('Publish the form first', 'FORM_NOT_PUBLISHED');
    const number = await this.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: chat.number.id }, select: { wabaId: true } });
    const flow = ((Array.isArray(version.metaFlows) ? version.metaFlows : []) as unknown as MetaFlow[]).find((f) => f.wabaId === number.wabaId && f.status === 'PUBLISHED' && f.flowId);
    if (!flow) throw AppError.conflict("The form is not published to this number's WhatsApp account; publish it again", 'NUMBER_NO_FORM');
    if (!chat.contact) throw AppError.validation('This contact was deleted, so the chat cannot be answered');
    const token = this.tokens.encode({ versionId: version.id, contactId: chat.contact.id, ref: 'chat', refId: conversationId });
    const item = await this.sessions.sendPrepared(viewer, chat, {
      contentType: 'FORM',
      text: input.body,
      mediaAssetId: null,
      payload: { formId: form.id, formName: form.name, versionId: version.id, flowId: flow.flowId, cta: input.cta, token, ...(input.header ? { header: input.header } : {}) },
    });
    return { chatItemId: item.id };
  }
}

const actorOf = (user: RequestUser, req: AuthedRequest) => ({ userId: user.id, ip: clientIp(req) ?? null });

/** /forms (contracts/commerce-api.openapi.yaml tag forms). */
@Controller()
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get('forms')
  @Require('inbox.view')
  list(@Query(new ZodValidationPipe(ListFormsSchema)) query: z.infer<typeof ListFormsSchema>, @CurrentUser() user: RequestUser) {
    return this.forms.list(query.status, user);
  }

  @Post('forms')
  @Require('forms.manage')
  create(@Body(new ZodValidationPipe(CreateFormSchema)) body: z.infer<typeof CreateFormSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.forms.create(body, actorOf(user, req));
  }

  @Get('forms/:id')
  @Require('inbox.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.forms.get(id);
  }

  @Put('forms/:id')
  @Require('forms.manage')
  save(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SaveFormSchema)) body: z.infer<typeof SaveFormSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.forms.save(id, body, actorOf(user, req));
  }

  @Delete('forms/:id')
  @HttpCode(204)
  @Require('forms.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.forms.remove(id);
  }

  @Post('forms/:id/check')
  @HttpCode(200)
  @Require('forms.manage')
  check(@Param('id', ParseUUIDPipe) id: string) {
    return this.forms.check(id);
  }

  @Post('forms/:id/publish')
  @Require('forms.manage')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.forms.publish(id, actorOf(user, req));
  }

  @Post('forms/:id/archive')
  @HttpCode(200)
  @Require('forms.manage')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.forms.archive(id, actorOf(user, req));
  }

  @Get('forms/:id/answers')
  @Require('forms.manage')
  answers(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(AnswersQuerySchema)) query: z.infer<typeof AnswersQuerySchema>, @CurrentUser() user: RequestUser) {
    return this.forms.answers(id, query, user);
  }

  @Get('forms/:id/answers/export.csv')
  @Require('data.export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    await this.forms.exportAnswers(id, user, req, res);
  }

  @Post('inbox/conversations/:id/forms')
  @Require('inbox.reply')
  send(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SendFormSchema)) body: z.infer<typeof SendFormSchema>, @CurrentUser() user: RequestUser) {
    return this.forms.send(user, id, body);
  }
}
