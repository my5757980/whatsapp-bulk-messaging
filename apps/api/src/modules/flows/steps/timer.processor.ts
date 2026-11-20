import { Injectable, type OnModuleInit } from '@nestjs/common';
import { FlowSessionService } from '../engine/session.service.js';
import { FLOW_TIMER_JOB, type FlowTimerData } from './flow-jobs.js';
import { FlowsQueueProcessor } from './flows-queue.processor.js';

/**
 * Runs `flow-timer` jobs (003 T034, research R10): a question, list or buttons timeout. The session
 * service ignores the timer when the session has moved to a newer wait (stale token) or ended.
 */
@Injectable()
export class FlowTimerProcessor implements OnModuleInit {
  constructor(
    private readonly flowsQueue: FlowsQueueProcessor,
    private readonly sessions: FlowSessionService,
  ) {}

  onModuleInit(): void {
    this.flowsQueue.handle(FLOW_TIMER_JOB, (job) => this.run(job.data as FlowTimerData));
  }

  async run(data: FlowTimerData): Promise<void> {
    await this.sessions.resume(data.sessionId, { kind: 'timer', token: data.token });
  }
}
