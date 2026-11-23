import { Injectable } from '@nestjs/common';
import type { MetaTemplateComponent } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Campaign, Prisma, Template, WhatsAppNumber } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { TrackedLinkCodes } from '../growth/links/link-codes.js';
import { TrackedLinksService } from '../growth/links/tracked-links.service.js';
import { RateCardService } from '../rate-card/rate-card.controller.js';
import { rateCategory } from '../reports/cost-calculator.js';
import { headerMediaType } from '../sending/template-payload.builder.js';
import { AudienceSnapshotService } from './audience-snapshot.service.js';
import { CampaignsService, toCampaignDto } from './campaigns.service.js';
import { DispatchScheduler } from './dispatch-scheduler.js';
import { unmappedVariables, type VariableMapping } from './variable-resolver.js';

// Launch (T096): validate, snapshot recipients into `messages`, set RUNNING and start the
// dispatcher. The snapshot and the state change commit together, so a half-written campaign is
// never visible and a concurrent second launch gets 409. Scheduled campaigns (T147) are validated
// when scheduled and snapshotted here at their start time.

export const LaunchSchema = z
  .object({
    scheduledAt: z.iso.datetime({ offset: true }).nullish(),
    timezone: z.string().trim().min(1).optional(),
  })
  .strict()
  .optional()
  .transform((v) => v ?? {});
export type LaunchInput = z.infer<typeof LaunchSchema>;

const INSERT_BATCH = 1000;

export type LaunchableCampaign = Campaign & { template: Template | null; number: WhatsAppNumber | null };

@Injectable()
export class LaunchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: AudienceSnapshotService,
    private readonly campaigns: CampaignsService,
    private readonly dispatch: DispatchScheduler,
    private readonly audit: AuditService,
    private readonly rateCard: RateCardService,
    private readonly trackedLinks: TrackedLinksService,
    private readonly codes: TrackedLinkCodes,
  ) {}

  async load(campaignId: string): Promise<LaunchableCampaign> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, include: { template: true, number: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    return campaign;
  }

  /** Send now (POST /campaigns/{id}/launch without scheduledAt). */
  async launch(campaignId: string, _input: LaunchInput, actor: AuditActor) {
    const campaign = await this.load(campaignId);
    if (campaign.state !== 'DRAFT') throw AppError.conflict('Only draft campaigns can be launched');
    await this.validate(campaign);
    return this.snapshotAndRun(campaign, 'DRAFT', actor);
  }

  /** Everything a launch needs, now or at a scheduled time (checked when it is scheduled). */
  async validate(campaign: LaunchableCampaign): Promise<{ template: Template; number: WhatsAppNumber }> {
    const { template, number } = campaign;
    if (!template) throw AppError.validation('Choose a template first', [{ field: 'templateId', issue: 'is required' }]);
    if (!number) throw AppError.validation('Choose a WhatsApp number first', [{ field: 'numberId', issue: 'is required' }]);
    if (template.status !== 'APPROVED') throw AppError.conflict('The template is not approved by Meta');
    if (template.wabaId !== number.wabaId) throw AppError.conflict('The template belongs to a different WhatsApp Business Account');
    if (number.connectionStatus !== 'CONNECTED') throw AppError.conflict('The WhatsApp number is not connected');
    if (!number.sendingEnabled) throw AppError.conflict('Sending is turned off for this number');

    const variables = (Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>;
    // Tracked-link variables (feature 005) carry each recipient's code instead of a mapping.
    const tracked = await this.snapshot.trackedKeys(campaign.id, variables);
    const unmapped = unmappedVariables(
      variables.filter((v) => !tracked.has(v.key)),
      (campaign.variableMapping ?? {}) as VariableMapping,
    );
    if (unmapped.length) {
      throw AppError.validation('Map every template variable', unmapped.map((key) => ({ field: `variableMapping.${key}`, issue: 'is not mapped' })));
    }
    const components = template.components as unknown as MetaTemplateComponent[];
    const untracked = this.trackedLinks.buttonsWithoutDestination(components, tracked);
    if (untracked.length) {
      throw AppError.validation(
        'Set where each tracked link button goes',
        untracked.map((key) => ({ field: `trackedLinks.${key}`, issue: 'needs a destination' })),
      );
    }
    if (headerMediaType(components) && !campaign.headerMediaAssetId) {
      throw AppError.validation('This template needs header media', [{ field: 'headerMediaAssetId', issue: 'is required' }]);
    }
    await this.snapshot.assertReady(campaign);
    return { template, number };
  }

  /** Takes the recipient snapshot and moves the campaign from `fromState` to RUNNING. */
  async snapshotAndRun(campaign: LaunchableCampaign, fromState: 'DRAFT' | 'SCHEDULED', actor: AuditActor) {
    const { template, number } = campaign;
    if (!template || !number) throw AppError.conflict('The campaign has no template or number');
    const campaignId = campaign.id;
    let recipients = 0;
    let eligible = 0;
    let costMicros = 0n;
    const table = await this.rateCard.table();
    const category = rateCategory(null, template.category);
    await this.prisma.$transaction(
      async (tx) => {
        const { count } = await tx.campaign.updateMany({
          where: { id: campaignId, state: fromState },
          data: { state: 'RUNNING', launchedAt: new Date(), pausedReason: null, totals: {} },
        });
        if (!count) throw AppError.conflict(fromState === 'DRAFT' ? 'Only draft campaigns can be launched' : 'The campaign is no longer scheduled');
        await tx.message.deleteMany({ where: { campaignId } });
        // Tracked links (feature 005): every recipient gets their own code per tracked variable.
        const variables = (Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>;
        const trackedKeys = await this.snapshot.trackedKeys(campaignId, variables, tx);
        const targets = (await this.trackedLinks.targetsOf(campaignId, tx)).filter((t) => trackedKeys.has(t.variableKey));

        for await (const batch of this.snapshot.evaluate(campaign, template, tx)) {
          for (let i = 0; i < batch.length; i += INSERT_BATCH) {
            const slice = batch.slice(i, i + INSERT_BATCH).map((r) => ({ ...r, id: uuidv7() }));
            const plan = targets.length
              ? this.codes.plan(
                  slice.filter((r) => r.status === 'PENDING').map((r) => ({ id: r.id, contactId: r.contactId })),
                  targets,
                )
              : null;
            const data = slice.map((r) => ({
              id: r.id,
              origin: 'CAMPAIGN' as const,
              campaignId,
              contactId: r.contactId,
              phoneE164: r.phoneE164,
              recipientCountry: r.countryCode,
              numberId: number.id,
              templateId: template.id,
              resolvedParams: { ...r.params, ...(plan?.params.get(r.id) ?? {}) } as Prisma.InputJsonValue,
              status: r.status,
              skipReason: r.skipReason,
            }));
            if (plan) {
              const inserted = await tx.message.createManyAndReturn({ data, skipDuplicates: true, select: { id: true } });
              const ids = new Set(inserted.map((m) => m.id));
              await this.codes.save(
                tx,
                plan.links.filter((l) => ids.has(l.messageId)),
                targets,
              );
            } else {
              await tx.message.createMany({ data, skipDuplicates: true });
            }
            recipients += slice.length;
            for (const r of slice) {
              if (r.status !== 'PENDING') continue;
              eligible++;
              costMicros += table.rate(category, r.countryCode) ?? 0n;
            }
          }
        }
      },
      { timeout: 10 * 60_000, maxWait: 10_000 },
    );

    const totals = await this.campaigns.computeTotals(campaignId);
    const launched = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { totals: totals as unknown as Prisma.InputJsonValue, estimatedCostUsdMicros: costMicros },
      include: { template: { select: { name: true } }, number: { select: { label: true } }, createdBy: { select: { name: true } } },
    });
    await this.dispatch.schedule(campaignId);
    await this.audit.record(actor, 'campaign.launched', { type: 'campaign', id: campaignId }, { recipients, eligible, scheduled: fromState === 'SCHEDULED' });
    return toCampaignDto(launched, totals);
  }
}
