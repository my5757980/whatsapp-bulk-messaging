import { Controller, Get, Global, Header, Injectable, Module, UseGuards } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { OpsTokenGuard } from '../auth/ops-token.guard.js';
import { Public } from '../auth/public.decorator.js';

/** Delivery metrics (constitution Principle VI, research R19). */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Refreshes that run right before each scrape (see onScrape). */
  private readonly scrapeCollectors: Array<() => Promise<void>> = [];

  readonly messagesTotal = new Counter({
    name: 'wbm_messages_total',
    help: 'Messages by status and sending number',
    labelNames: ['status', 'number'] as const,
    registers: [this.registry],
  });

  readonly sendErrorsTotal = new Counter({
    name: 'wbm_send_errors_total',
    help: 'Meta send errors by error code',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });

  /** Feature 009 (research R12): Meta error codes without a help entry, so maintainers know which to add. */
  readonly unknownErrorCodes = new Counter({
    name: 'wbm_unknown_error_codes_total',
    help: 'Meta error codes seen without an entry in the help meanings',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });

  /**
   * Jobs ready to run but not picked up yet. Delayed jobs (retry backoff, the next run of a job
   * scheduler) are left out, so an idle queue reads 0 and a growing value means a backlog.
   */
  readonly queueDepth = new Gauge({
    name: 'wbm_queue_depth',
    help: 'Jobs waiting to run per queue (delayed retries and scheduled runs excluded)',
    labelNames: ['queue'] as const,
    registers: [this.registry],
    collect: async () => {
      await Promise.all(this.scrapeCollectors.map((refresh) => refresh().catch(() => undefined)));
    },
  });

  readonly webhookLag = new Histogram({
    name: 'wbm_webhook_lag_seconds',
    help: 'Seconds between the Meta event timestamp and its processing',
    buckets: [1, 5, 15, 30, 60, 120, 300],
    registers: [this.registry],
  });

  readonly campaignsRunning = new Gauge({
    name: 'wbm_campaigns_running',
    help: 'Campaigns currently in RUNNING state',
    registers: [this.registry],
  });

  // ---- Live chat (feature 002, T099) ----

  readonly inboxMessagesTotal = new Counter({
    name: 'wbm_inbox_messages_total',
    help: 'Live chat messages: customer messages received (in) and replies or chat templates sent (out), by content type',
    labelNames: ['direction', 'kind'] as const,
    registers: [this.registry],
  });

  readonly inboxEventLag = new Histogram({
    name: 'wbm_inbox_event_lag_seconds',
    help: 'Seconds between publishing a live chat event and the api instance reading it for its browsers',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly inboxSseConnections = new Gauge({
    name: 'wbm_inbox_sse_connections',
    help: 'Open live chat event streams on this api instance',
    registers: [this.registry],
  });

  readonly inboundMediaFailuresTotal = new Counter({
    name: 'wbm_inbound_media_failures_total',
    help: 'Customer media that could not be downloaded from Meta after all attempts',
    registers: [this.registry],
  });

  // ---- Chatbot flows (feature 003, T082) ----

  readonly flowSessionsTotal = new Counter({
    name: 'wbm_flow_sessions_total',
    help: 'Finished chatbot flow sessions by result (test runs left out)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly flowStepsTotal = new Counter({
    name: 'wbm_flow_steps_total',
    help: 'Chatbot flow steps entered, by step type (test runs left out)',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly flowApiCallsTotal = new Counter({
    name: 'wbm_flow_api_calls_total',
    help: 'API step calls by outcome: success, error_status, timeout, blocked or failed',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly flowApiDuration = new Histogram({
    name: 'wbm_flow_api_duration_seconds',
    help: 'Seconds an API step call took, until its reply or failure',
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  // ---- AI agent (feature 004, T104) ----

  readonly aiTurnsTotal = new Counter({
    name: 'wbm_ai_turns_total',
    help: 'AI customer turns by result: sent, failed, limited, opted_out, dropped, newer, nothing or not_eligible',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly aiTurnDuration = new Histogram({
    name: 'wbm_ai_turn_duration_seconds',
    help: 'Seconds an AI turn took from its start to its result, model call included (turns that called the model)',
    buckets: [0.5, 1, 2, 3, 5, 8, 13, 20, 30],
    registers: [this.registry],
  });

  readonly aiTokensTotal = new Counter({
    name: 'wbm_ai_tokens_total',
    help: 'Tokens used with the AI service, by kind: input, cache_read, cache_write or output',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly aiRepliesTotal = new Counter({
    name: 'wbm_ai_replies_total',
    help: 'AI replies counted against the monthly limit, by whether they went to a test number',
    labelNames: ['test'] as const,
    registers: [this.registry],
  });

  readonly aiKnowledgeJobsTotal = new Counter({
    name: 'wbm_ai_knowledge_jobs_total',
    help: 'Knowledge files and websites read, by kind (file or website) and outcome (ready or failed)',
    labelNames: ['kind', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly aiAssistantRequestsTotal = new Counter({
    name: 'wbm_ai_assistant_requests_total',
    help: 'Team assistant requests answered, by outcome: done, refused or failed',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Campaign growth (feature 005, research R13).
  readonly linkClicksTotal = new Counter({
    name: 'wbm_link_clicks_total',
    help: 'Tracked links opened, by kind: click (counted), preview (previews and robots), unknown (no such code) or limited (too many from one address)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly linkRedirectDuration = new Histogram({
    name: 'wbm_link_redirect_seconds',
    help: 'Time to answer a tracked link (lookup, click record and redirect)',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [this.registry],
  });

  readonly campaignRetryMessagesTotal = new Counter({
    name: 'wbm_campaign_retry_messages_total',
    help: 'Campaign messages in retry rounds, by outcome: requeued (sent again) or recovered (then sent)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly dripStepsTotal = new Counter({
    name: 'wbm_drip_steps_total',
    help: 'Drip steps handled by the tick, by result: queued or skipped',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly dripEnrolmentsTotal = new Counter({
    name: 'wbm_drip_enrolments_total',
    help: 'Contacts who joined a drip, by how: manual or event',
    labelNames: ['via'] as const,
    registers: [this.registry],
  });

  readonly dripDueLag = new Histogram({
    name: 'wbm_drip_due_lag_seconds',
    help: 'Time from a drip step falling due to its message being queued (quiet hours excluded)',
    buckets: [5, 15, 30, 60, 120, 300, 600, 1800],
    registers: [this.registry],
  });

  // Integrations (feature 006, research R14).
  readonly webhookDeliveriesTotal = new Counter({
    name: 'wbm_webhook_deliveries_total',
    help: 'Webhook delivery attempts, by result: delivered, retry (failed, tried again later) or failed (gave up)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly webhookDeliverySeconds = new Histogram({
    name: 'wbm_webhook_delivery_seconds',
    help: 'Time from an event happening to its delivery to an endpoint',
    buckets: [1, 2, 5, 10, 30, 60, 300, 1800, 7200],
    registers: [this.registry],
  });

  readonly webhookBacklog = new Gauge({
    name: 'wbm_webhook_backlog',
    help: 'Deliveries to active endpoints that have been due for more than 5 minutes',
    registers: [this.registry],
  });

  readonly storeEventsTotal = new Counter({
    name: 'wbm_store_events_total',
    help: 'Store webhook events handled, by platform and result: processed, ignored or failed',
    labelNames: ['platform', 'result'] as const,
    registers: [this.registry],
  });

  readonly storeMessagesTotal = new Counter({
    name: 'wbm_store_messages_total',
    help: 'Store notifications, COD questions and cart reminders, by kind and result: queued or skipped',
    labelNames: ['kind', 'result'] as const,
    registers: [this.registry],
  });

  readonly apiCampaignTriggersTotal = new Counter({
    name: 'wbm_api_campaign_triggers_total',
    help: 'API campaign calls recorded, by result: queued or not_sent',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly chatLinkOpensTotal = new Counter({
    name: 'wbm_chat_link_opens_total',
    help: 'Chat links opened, by kind: open (counted), preview (previews and robots), unknown, off (turned off or deleted) or limited',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  // Feature 007 ads (research R13).
  readonly adsSyncTotal = new Counter({
    name: 'wbm_ads_sync_total',
    help: 'Reads from Meta by job (status, insights, audiences, leads) and result (ok or failed)',
    labelNames: ['job', 'result'] as const,
    registers: [this.registry],
  });

  readonly adChatStartsTotal = new Counter({
    name: 'wbm_ad_chat_starts_total',
    help: 'Chats started from Click-to-WhatsApp ads, by whether the ad is one of the platform\'s (matched true or false)',
    labelNames: ['matched'] as const,
    registers: [this.registry],
  });

  readonly adLeadsTotal = new Counter({
    name: 'wbm_ad_leads_total',
    help: 'Leads from lead forms, by result: processed, no_phone, invalid_phone or unknown_form',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly adsSpendCapPausesTotal = new Counter({
    name: 'wbm_ads_spend_cap_pauses_total',
    help: 'Ad campaigns paused because the monthly spending cap was reached',
    registers: [this.registry],
  });

  // Feature 008 (research R14): payments, chat orders, forms and the catalog.
  readonly paymentLinksTotal = new Counter({
    name: 'wbm_payment_links_total',
    help: 'Payment requests made, by result: created, or failed when Stripe refused or could not be reached',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly paymentEventsTotal = new Counter({
    name: 'wbm_payment_events_total',
    help: 'Stripe events processed, by type, result (APPLIED, IGNORED, FAILED, PENDING) and source (WEBHOOK, RECONCILE, CHECK)',
    labelNames: ['type', 'result', 'source'] as const,
    registers: [this.registry],
  });

  readonly paymentsTotal = new Counter({
    name: 'wbm_payments_total',
    help: 'Payment requests that reached a status: PAID, EXPIRED, CANCELLED or REFUNDED',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  readonly chatOrdersTotal = new Counter({
    name: 'wbm_chat_orders_total',
    help: 'Carts received in chat, by mode (AUTO, REVIEW, FLOW)',
    labelNames: ['mode'] as const,
    registers: [this.registry],
  });

  readonly formAnswersTotal = new Counter({
    name: 'wbm_form_answers_total',
    help: 'WhatsApp Form answers, by result: valid, with_problems, or untrusted (a token that is not ours)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly catalogSyncTotal = new Counter({
    name: 'wbm_catalog_sync_total',
    help: 'Catalog jobs (copy, fill, batch) by result (ok or failed)',
    labelNames: ['job', 'result'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  /** Registers a refresh that runs right before each /metrics scrape. */
  onScrape(refresh: () => Promise<void>): void {
    this.scrapeCollectors.push(refresh);
  }
}

/** GET /metrics (outside the /api prefix), protected by X-Ops-Token (T037). */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @UseGuards(OpsTokenGuard)
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

@Global()
@Module({ providers: [MetricsService], controllers: [MetricsController], exports: [MetricsService] })
export class MetricsModule {}
