import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { FlowSecretsVault } from '../definitions/secrets-vault.js';
import { FlowSessionService } from '../engine/session.service.js';
import { ApiCallError, callApi, mapFields } from './api-client.js';
import { buildApiRequest, secretIdsIn } from './api-request.js';
import { FLOW_API_JOB, type FlowApiData } from './flow-jobs.js';
import { FlowsQueueProcessor } from './flows-queue.processor.js';

/**
 * Runs `flow-api` jobs (003 T058, research R11): renders the API step's request with the session's
 * values and secrets, calls it with the safe client, maps the reply into answers and resumes the
 * session on its success or failed branch. Logs carry the reason or status only, never the address,
 * headers or reply, which may hold secrets or personal data.
 */
@Injectable()
export class FlowApiProcessor implements OnModuleInit {
  private readonly logger = new Logger(FlowApiProcessor.name);

  constructor(
    private readonly flowsQueue: FlowsQueueProcessor,
    private readonly sessions: FlowSessionService,
    private readonly vault: FlowSecretsVault,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.flowsQueue.handle(FLOW_API_JOB, (job) => this.run(job.data as FlowApiData));
  }

  async run(data: FlowApiData): Promise<void> {
    const call = await this.sessions.apiCall(data.sessionId, data.token);
    if (!call) return;
    let ok = false;
    let mapped: Record<string, string | number> = {};
    let outcome = 'failed';
    const started = Date.now();
    try {
      const secrets = await this.vault.values(call.flowId, secretIdsIn(call.step));
      const reply = await callApi(buildApiRequest(call.step, { contact: call.contact, answers: call.answers, secrets }));
      ok = reply.status >= 200 && reply.status < 300;
      outcome = ok ? 'success' : 'error_status';
      if (ok) mapped = mapFields(reply.body, call.step.map);
      else this.logger.warn({ sessionId: data.sessionId, stepId: call.step.id, status: reply.status }, 'Flow API step got an error status');
    } catch (error) {
      const reason = error instanceof ApiCallError ? error.reason : 'NETWORK';
      outcome = reason === 'TIMEOUT' ? 'timeout' : reason === 'BLOCKED_ADDRESS' ? 'blocked' : 'failed';
      this.logger.warn({ sessionId: data.sessionId, stepId: call.step.id, reason }, 'Flow API step failed');
    } finally {
      this.metrics.flowApiCallsTotal.inc({ outcome });
      this.metrics.flowApiDuration.observe((Date.now() - started) / 1000);
    }
    await this.sessions.resume(data.sessionId, { kind: 'api', token: data.token, ok, mapped });
  }
}
