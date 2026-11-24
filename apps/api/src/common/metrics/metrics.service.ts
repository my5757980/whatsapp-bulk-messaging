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
