import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_TRACKED_LINKS,
  destinationProblem,
  extractTemplateVariables,
  isTrackedButtonUrl,
  parseVariableKey,
  trackedButtonUrl,
  type MetaTemplateComponent,
} from '@wbm/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma, TrackedLinkTarget } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';

// Tracked links of a campaign (feature 005 US1, FR-001, FR-006, FR-007, research R2).

const LinkInputSchema = z
  .object({
    variableKey: z.string().trim().min(1).max(20),
    destination: z.string().trim().min(1).max(2000),
    addCampaignTags: z.boolean().default(false),
  })
  .strict();

export const TrackedLinksInputSchema = z
  .object({ links: z.array(LinkInputSchema).max(MAX_TRACKED_LINKS) })
  .strict()
  .refine((v) => new Set(v.links.map((l) => l.variableKey)).size === v.links.length, { message: 'Each variable can carry one tracked link', path: ['links'] });
export type TrackedLinksInput = z.infer<typeof TrackedLinksInputSchema>;

export const TargetPatchSchema = z
  .object({ destination: z.string().trim().min(1).max(2000).optional(), addCampaignTags: z.boolean().optional() })
  .strict()
  .refine((v) => v.destination !== undefined || v.addCampaignTags !== undefined, { message: 'Change the destination or the campaign tags' });
export type TargetPatch = z.infer<typeof TargetPatchSchema>;

export interface TrackedLinkTargetDto {
  id: string;
  variableKey: string;
  destination: string;
  addCampaignTags: boolean;
}

export interface TrackableVariable {
  variableKey: string;
  kind: 'URL_BUTTON' | 'TEXT_VARIABLE';
  trackable: boolean;
  reason: string | null;
}

export interface TrackedLinkSet {
  links: TrackedLinkTargetDto[];
  trackable: TrackableVariable[];
}

const DESTINATION_ISSUE: Record<string, string> = {
  INVALID_URL: 'is not a valid web address',
  NOT_HTTP: 'must start with https:// or http://',
  TOO_LONG: 'is longer than 2,000 characters',
  ON_TRACKING_ADDRESS: 'points back at the tracked-link address',
};

export function toTargetDto(row: Pick<TrackedLinkTarget, 'id' | 'variableKey' | 'destination' | 'addCampaignTags'>): TrackedLinkTargetDto {
  return { id: row.id, variableKey: row.variableKey, destination: row.destination, addCampaignTags: row.addCampaignTags };
}

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class TrackedLinksService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /** The tracked-link address, so the template editor can make a Tracked link button. */
  settings(): { enabled: boolean; baseUrl: string | null; buttonUrl: string | null } {
    const base = this.config.PUBLIC_LINK_BASE_URL;
    return { enabled: Boolean(base), baseUrl: base ?? null, buttonUrl: base ? trackedButtonUrl(base) : null };
  }

  /** Which of a template's variables can carry a tracked link, and why the others cannot (research R2). */
  trackable(components: MetaTemplateComponent[]): TrackableVariable[] {
    const base = this.config.PUBLIC_LINK_BASE_URL;
    const buttons = components.find((c) => c.type.toUpperCase() === 'BUTTONS')?.buttons ?? [];
    return extractTemplateVariables(components).map(({ key }) => {
      const ref = parseVariableKey(key);
      const kind = ref?.component === 'BUTTON' ? 'URL_BUTTON' : 'TEXT_VARIABLE';
      if (!base) return { variableKey: key, kind, trackable: false, reason: 'Link tracking is not set up on this server' };
      if (kind === 'TEXT_VARIABLE') return { variableKey: key, kind, trackable: true, reason: null };
      const url = buttons[ref?.index ?? 0]?.url ?? '';
      return isTrackedButtonUrl(url, base)
        ? { variableKey: key, kind, trackable: true, reason: null }
        : {
            variableKey: key,
            kind,
            trackable: false,
            reason: 'The button address does not start with the tracked-link address. Make the template with a Tracked link button to track it.',
          };
    });
  }

  /** URL buttons on the tracked-link address that have no destination yet: their links would lead nowhere. */
  buttonsWithoutDestination(components: MetaTemplateComponent[], trackedKeys: ReadonlySet<string>): string[] {
    return this.trackable(components)
      .filter((v) => v.kind === 'URL_BUTTON' && v.trackable && !trackedKeys.has(v.variableKey))
      .map((v) => v.variableKey);
  }

  async targetsOf(campaignId: string, db: Db = this.prisma): Promise<TrackedLinkTarget[]> {
    return db.trackedLinkTarget.findMany({ where: { campaignId }, orderBy: { variableKey: 'asc' } });
  }

  async trackedKeys(campaignId: string, db: Db = this.prisma): Promise<Set<string>> {
    const rows = await db.trackedLinkTarget.findMany({ where: { campaignId }, select: { variableKey: true } });
    return new Set(rows.map((r) => r.variableKey));
  }

  async list(campaignId: string): Promise<TrackedLinkSet> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, template: { select: { components: true } } } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    const components = (campaign.template?.components ?? []) as unknown as MetaTemplateComponent[];
    return { links: (await this.targetsOf(campaignId)).map(toTargetDto), trackable: this.trackable(components) };
  }

  /** Replaces the tracked links of a draft or scheduled campaign (FR-001, FR-007); drafts are not audited, like 001 campaign edits. */
  async replace(campaignId: string, input: TrackedLinksInput): Promise<TrackedLinkSet> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, state: true, template: { select: { components: true } } } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    if (campaign.state !== 'DRAFT' && campaign.state !== 'SCHEDULED') {
      throw AppError.conflict('Tracked links can only change before the campaign starts; change a destination instead', 'CAMPAIGN_NOT_EDITABLE');
    }
    const trackable = new Map(this.trackable((campaign.template?.components ?? []) as unknown as MetaTemplateComponent[]).map((v) => [v.variableKey, v]));
    for (const link of input.links) {
      const variable = trackable.get(link.variableKey);
      if (!variable?.trackable) {
        throw AppError.validation(
          variable?.reason ?? `The template has no variable ${link.variableKey}`,
          [{ field: `links.${link.variableKey}`, issue: 'cannot carry a tracked link' }],
          'LINK_NOT_TRACKABLE',
        );
      }
      this.assertDestination(link.destination, `links.${link.variableKey}.destination`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.trackedLinkTarget.deleteMany({ where: { campaignId } });
      if (input.links.length) {
        await tx.trackedLinkTarget.createMany({
          data: input.links.map((l) => ({ campaignId, variableKey: l.variableKey, destination: l.destination, addCampaignTags: l.addCampaignTags })),
        });
      }
    });
    return this.list(campaignId);
  }

  /** Changes a destination or the campaign tags, also while links are in use (FR-006; audited). */
  async updateTarget(id: string, patch: TargetPatch, actor: AuditActor): Promise<TrackedLinkTargetDto> {
    const target = await this.prisma.trackedLinkTarget.findUnique({ where: { id } });
    if (!target) throw AppError.notFound('Tracked link not found');
    if (patch.destination !== undefined) this.assertDestination(patch.destination, 'destination', 'VALIDATION_FAILED');
    const updated = await this.prisma.trackedLinkTarget.update({
      where: { id },
      data: { ...(patch.destination !== undefined ? { destination: patch.destination } : {}), ...(patch.addCampaignTags !== undefined ? { addCampaignTags: patch.addCampaignTags } : {}) },
    });
    await this.audit.record(actor, 'tracked_link.destination_changed', { type: 'tracked_link', id }, {
      campaignId: target.campaignId,
      dripStepId: target.dripStepId,
      variableKey: target.variableKey,
      from: target.destination,
      to: updated.destination,
      addCampaignTags: updated.addCampaignTags,
    });
    return toTargetDto(updated);
  }

  assertDestination(destination: string, field: string, code = 'BAD_DESTINATION'): void {
    const problem = destinationProblem(destination, this.config.PUBLIC_LINK_BASE_URL);
    if (problem) throw AppError.validation(`The destination ${DESTINATION_ISSUE[problem] ?? 'is not valid'}`, [{ field, issue: DESTINATION_ISSUE[problem] ?? problem }], code);
  }
}
