import { Injectable } from '@nestjs/common';
import { FlowStepSchema } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ApiCallError, callApi, mapFields } from '../steps/api-client.js';
import { buildApiRequest, secretIdsIn } from '../steps/api-request.js';
import { FlowsService } from './flows.service.js';
import { FlowSecretsVault } from './secrets-vault.js';

export const ApiTestSchema = z.strictObject({
  step: z.record(z.string(), z.unknown()),
  answers: z.record(z.string(), z.string().max(1000)).optional(),
  contactId: z.uuid().optional(),
});
export type ApiTestInput = z.infer<typeof ApiTestSchema>;

/** Text replies (errors, HTML) are cut to this size for the editor. */
const TEXT_PREVIEW = 2048;

/**
 * The editor's Test request (003 T059, FR-014): runs an API step once with sample answers and an
 * optional contact, through the same client and safety rules as at run time.
 */
@Injectable()
export class ApiTestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
    private readonly vault: FlowSecretsVault,
  ) {}

  async run(flowId: string, input: ApiTestInput) {
    await this.flows.load(flowId);
    const parsed = FlowStepSchema.safeParse(input.step);
    if (!parsed.success || parsed.data.type !== 'api') {
      throw AppError.validation('The step is not a valid API step', [{ field: 'step', issue: parsed.success ? 'is not an API step' : (parsed.error.issues[0]?.message ?? 'is invalid') }]);
    }
    const step = parsed.data;
    const contact = input.contactId ? await this.prisma.contact.findUnique({ where: { id: input.contactId }, select: { name: true, phoneE164: true, attributes: true } }) : null;
    if (input.contactId && !contact) throw AppError.notFound('Contact not found');
    const secrets = await this.vault.values(flowId, secretIdsIn(step));
    const request = buildApiRequest(step, {
      contact: { name: contact?.name ?? null, phoneE164: contact?.phoneE164 ?? null, attributes: (contact?.attributes ?? {}) as Record<string, unknown> },
      answers: input.answers ?? {},
      secrets,
    });
    const started = Date.now();
    try {
      const reply = await callApi(request);
      const ok = reply.status >= 200 && reply.status < 300;
      return {
        ok,
        status: reply.status,
        durationMs: Date.now() - started,
        body: reply.body ?? (reply.text ? reply.text.slice(0, TEXT_PREVIEW) : null),
        mapped: ok ? mapFields(reply.body, step.map) : {},
        error: null,
      };
    } catch (error) {
      return { ok: false, status: null, durationMs: Date.now() - started, body: null, mapped: {}, error: error instanceof ApiCallError ? error.reason : 'NETWORK' };
    }
  }
}
