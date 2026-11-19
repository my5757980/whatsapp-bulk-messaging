import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { INBOX_QUEUE, inboxNotifyJob, type InboxNotifyJobData } from '../inbox-queue.js';
import { PUSH_SENDER, type PushSender } from './push-sender.js';

/**
 * Queues push alerts (T087) from the HTTP app and the worker. Best effort: a failure to queue
 * never fails the message, transfer or note that caused it. Nothing is queued while push is off.
 */
@Injectable()
export class InboxNotifier {
  private readonly logger = new Logger(InboxNotifier.name);

  constructor(
    private readonly queues: QueueRegistry,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  async queue(data: InboxNotifyJobData): Promise<void> {
    if (!this.sender.enabled) return;
    if ('userIds' in data && data.userIds.length === 0) return;
    try {
      const job = inboxNotifyJob(data);
      await this.queues.get(INBOX_QUEUE).add(job.name, job.data, job.opts);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message, kind: data.kind, conversationId: data.conversationId }, 'Could not queue a push alert');
    }
  }
}
