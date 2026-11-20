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
