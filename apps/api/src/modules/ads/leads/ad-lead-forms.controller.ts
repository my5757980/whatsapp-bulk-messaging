import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AuditService } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import { VariableMappingSchema } from '../../campaigns/variable-resolver.js';
import { AdLeadFormsService, LeadFormInputSchema, LeadsQuerySchema, type LeadFormInput } from './ad-lead-forms.service.js';

const NEWLINE = '\n';
const PatchSchema = z
  .object({ tagId: z.uuid().nullable().optional(), welcomeTemplateId: z.uuid().nullable().optional(), welcomeMapping: VariableMappingSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'change at least one field' });

/** Lead forms and their leads (feature 007 US7, contracts/ads-api.openapi.yaml tag ad-lead-forms). */
@Controller('ads/lead-forms')
export class AdLeadFormsController {
  constructor(
    private readonly forms: AdLeadFormsService,
    private readonly audit: AuditService,
  ) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list() {
    return this.forms.list();
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(LeadFormInputSchema)) body: LeadFormInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.forms.create(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.forms.get(id);
  }

  @Patch(':id')
  @Require('campaigns.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PatchSchema)) body: z.infer<typeof PatchSchema>) {
    return this.forms.update(id, body);
  }

  @Get(':id/leads')
  @Require('campaigns.view')
  leads(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(LeadsQuerySchema)) query: z.infer<typeof LeadsQuerySchema>) {
    return this.forms.leads(id, query);
  }

  /** Leads as CSV; phones masked without phones.full; audited (FR-039). */
  @Get(':id/leads/export')
  @Require('data.export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const form = await this.forms.find(id);
    await this.audit.record(this.actor(user, req), 'ad_leads.exported', { type: 'ad_lead_form', id }, { format: 'csv' });
    const fullPhones = can(user.role, 'phones.full');
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="leads-${form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'form'}.csv"`);
    res.write(`submitted_at,name,phone,email,consent,status,answers${NEWLINE}`);
    for await (const page of this.forms.exportRows(id)) {
      const chunk = page
        .map((l) => {
          const answers = { ...((l.answers ?? {}) as Record<string, string>) };
          delete answers.phone_number;
          return [l.submittedAt.toISOString(), answers.full_name ?? '', fullPhones ? (l.phoneE164 ?? '') : (maskPhone(l.phoneE164) ?? ''), l.email ?? '', l.consent ? 'yes' : 'no', l.status, JSON.stringify(answers)]
            .map(csvField)
            .join(',');
        })
        .join(NEWLINE);
      if (!res.write(`${chunk}${NEWLINE}`)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }
}
