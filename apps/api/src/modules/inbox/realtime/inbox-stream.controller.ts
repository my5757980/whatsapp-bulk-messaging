import { Controller, Get, Logger, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import type { AuthedRequest } from '../../../common/auth/request-user.js';
import { StreamFanoutService } from './stream-fanout.service.js';

/** Live chat events as Server-Sent Events (T020, contracts/realtime-events.md). Read-only. */
@Controller('inbox')
export class InboxStreamController {
  private readonly logger = new Logger(InboxStreamController.name);

  constructor(private readonly fanout: StreamFanoutService) {}

  @Get('events')
  @Require('inbox.view')
  async events(@Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const user = req.user!;
    res.status(200);
    // no-transform stops compression middleware and proxies from buffering the stream (R1).
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    res.write('retry: 3000\n\n');

    try {
      await this.fanout.attach(
        {
          viewer: { id: user.id, role: user.role },
          sessionTokenHash: req.sessionTokenHash!,
          write: (chunk) => void res.write(chunk),
          bufferedBytes: () => res.writableLength,
          end: () => res.end(),
          // ServerResponse "close" fires when the client goes away (IncomingMessage "close" does not).
          onClose: (listener) => void res.on('close', listener),
        },
        req.header('last-event-id'),
      );
    } catch (error) {
      // Headers are already sent, so no error body: end the stream and let EventSource retry.
      this.logger.warn(
        { err: (error as Error).message, userId: user.id },
        'Live chat stream could not start',
      );
      res.end();
    }
  }
}
