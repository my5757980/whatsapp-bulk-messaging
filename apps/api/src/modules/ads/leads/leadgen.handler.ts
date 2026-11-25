import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WebhookRouter, type WebhookChange, type WebhookChangeHandler } from '../../webhooks/webhook-router.js';
import { AdsConnectionService } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';
import { AdLeadFormsService } from './ad-lead-forms.service.js';

/**
 * Page `leadgen` webhooks (feature 007 US7, FR-036, research R9): Meta posts them to the same signed
 * route as WhatsApp; the 001 receiver stores them and this handler fetches the lead and records it.
 * A failure is kept on the webhook event, and the 15-minute catch-up finds the lead later.
 */
@Injectable()
export class LeadgenHandler implements WebhookChangeHandler, OnModuleInit {
  readonly field = 'leadgen';
  readonly object = 'page';
  private readonly logger = new Logger(LeadgenHandler.name);

  constructor(
    private readonly router: WebhookRouter,
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly forms: AdLeadFormsService,
  ) {}

  onModuleInit(): void {
    this.router.register(this);
  }

  async handle(change: WebhookChange): Promise<void> {
    const leadgenId = typeof change.value.leadgen_id === 'string' || typeof change.value.leadgen_id === 'number' ? String(change.value.leadgen_id) : null;
    if (!leadgenId) return;
    const access = await this.connection.access();
    if (!access) {
      this.logger.warn({ leadgenId }, 'A lead arrived but no ad account is connected');
      return;
    }
    const lead = await this.ads.lead(access.pageToken ?? access.token, leadgenId);
    const outcome = await this.forms.ingest({ ...lead, formId: lead.formId ?? (typeof change.value.form_id === 'string' ? change.value.form_id : null), adId: lead.adId ?? (typeof change.value.ad_id === 'string' ? change.value.ad_id : null) });
    if (outcome === 'UNKNOWN_FORM') this.logger.debug({ leadgenId }, 'A lead for a form made outside the platform');
  }
}
