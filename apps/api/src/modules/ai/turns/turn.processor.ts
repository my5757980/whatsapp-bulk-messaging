import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AI_TURN_JOB, type AiTurnJobData } from '../ai-jobs.js';
import { AiQueueProcessor } from './ai-queue.processor.js';
import { TurnService } from './turn.service.js';

/**
 * Runs `ai-turn` jobs (T042). A turn that finds a newer customer message drops its reply: the
 * debounced follow-up job (BullMQ keepLastIfActive) answers all of them in one reply (FR-018).
 */
@Injectable()
export class TurnProcessor implements OnModuleInit {
  constructor(
    private readonly aiQueue: AiQueueProcessor,
    private readonly turns: TurnService,
  ) {}

  onModuleInit(): void {
    this.aiQueue.handle(AI_TURN_JOB, (job) => this.turns.run((job.data as AiTurnJobData).conversationId));
  }
}
