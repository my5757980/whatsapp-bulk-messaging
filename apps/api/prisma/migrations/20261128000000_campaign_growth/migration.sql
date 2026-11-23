-- Feature 005 campaign growth (specs/005-campaign-growth/data-model.md, T005). Generated with prisma
-- migrate diff, plus the partial unique indexes and check constraints that Prisma cannot declare.

-- CreateEnum
CREATE TYPE "ClickDevice" AS ENUM ('MOBILE', 'DESKTOP', 'OTHER');

-- CreateEnum
CREATE TYPE "RetryRoundStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'DONE', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DripStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DripTriggerKind" AS ENUM ('TAG_ADDED', 'OPTED_IN', 'IMPORTED', 'API_CREATED', 'LINK_CLICKED');

-- CreateEnum
CREATE TYPE "DripJoinVia" AS ENUM ('TAG_ADDED', 'OPTED_IN', 'IMPORTED', 'API_CREATED', 'LINK_CLICKED', 'MANUAL');

-- CreateEnum
CREATE TYPE "EnrolmentStatus" AS ENUM ('ACTIVE', 'FINISHED', 'LEFT');

-- CreateEnum
CREATE TYPE "DripLeftReason" AS ENUM ('REPLIED', 'OPTED_OUT', 'BLOCKED', 'DELETED', 'STOP_TAG', 'CLICKED', 'REMOVED', 'INVALID_NUMBER', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "StepOutcome" AS ENUM ('QUEUED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RetargetStatus" ADD VALUE 'CLICKED';
ALTER TYPE "RetargetStatus" ADD VALUE 'NOT_CLICKED';
ALTER TYPE "RetargetStatus" ADD VALUE 'REPLIED';
ALTER TYPE "RetargetStatus" ADD VALUE 'NOT_REPLIED';
ALTER TYPE "RetargetStatus" ADD VALUE 'HELD_BACK';

-- AlterEnum
ALTER TYPE "MessageOrigin" ADD VALUE 'DRIP';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JourneyEventType" ADD VALUE 'DRIP_JOINED';
ALTER TYPE "JourneyEventType" ADD VALUE 'DRIP_LEFT';
ALTER TYPE "JourneyEventType" ADD VALUE 'LINK_CLICKED';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "retry_delays_min" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "retry_rounds" SMALLINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "drip_enrolment_id" UUID,
ADD COLUMN     "drip_step_id" UUID,
ADD COLUMN     "retry_round" SMALLINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tracked_link_targets" (
    "id" UUID NOT NULL,
    "campaign_id" UUID,
    "drip_step_id" UUID,
    "variable_key" VARCHAR(20) NOT NULL,
    "destination" VARCHAR(2000) NOT NULL,
    "add_campaign_tags" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tracked_link_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_links" (
    "id" UUID NOT NULL,
    "code" CHAR(10) NOT NULL,
    "target_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "contact_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracked_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_clicks" (
    "id" UUID NOT NULL,
    "tracked_link_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "campaign_id" UUID,
    "drip_step_id" UUID,
    "contact_id" UUID,
    "device" "ClickDevice" NOT NULL,
    "clicked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_retry_rounds" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "round" SMALLINT NOT NULL,
    "status" "RetryRoundStatus" NOT NULL DEFAULT 'SCHEDULED',
    "due_at" TIMESTAMPTZ NOT NULL,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "recovered" INTEGER NOT NULL DEFAULT 0,
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_retry_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drips" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "number_id" UUID NOT NULL,
    "status" "DripStatus" NOT NULL DEFAULT 'DRAFT',
    "paused_reason" VARCHAR(40),
    "quiet_from" VARCHAR(5),
    "quiet_to" VARCHAR(5),
    "quiet_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7]::INTEGER[],
    "leave_on_reply" BOOLEAN NOT NULL DEFAULT true,
    "leave_on_click" BOOLEAN NOT NULL DEFAULT false,
    "stop_tag_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "allow_rejoin" BOOLEAN NOT NULL DEFAULT false,
    "activated_at" TIMESTAMPTZ,
    "paused_at" TIMESTAMPTZ,
    "archived_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "drips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_steps" (
    "id" UUID NOT NULL,
    "drip_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "template_id" UUID NOT NULL,
    "variable_mapping" JSONB NOT NULL DEFAULT '{}',
    "header_media_asset_id" UUID,
    "wait_minutes" INTEGER NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "drip_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_triggers" (
    "id" UUID NOT NULL,
    "drip_id" UUID NOT NULL,
    "kind" "DripTriggerKind" NOT NULL,
    "tag_id" UUID,
    "campaign_id" UUID,

    CONSTRAINT "drip_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_enrolments" (
    "id" UUID NOT NULL,
    "drip_id" UUID NOT NULL,
    "contact_id" UUID,
    "status" "EnrolmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_via" "DripJoinVia" NOT NULL,
    "joined_by_id" UUID,
    "current_position" SMALLINT NOT NULL DEFAULT 1,
    "next_due_at" TIMESTAMPTZ,
    "left_reason" "DripLeftReason",
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "drip_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_step_sends" (
    "id" UUID NOT NULL,
    "enrolment_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "outcome" "StepOutcome" NOT NULL,
    "skip_reason" VARCHAR(40),
    "message_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drip_step_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_events" (
    "id" BIGSERIAL NOT NULL,
    "kind" "DripTriggerKind" NOT NULL,
    "contact_id" UUID NOT NULL,
    "tag_id" UUID,
    "campaign_id" UUID,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drip_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_link_targets_campaign_id_variable_key_key" ON "tracked_link_targets"("campaign_id", "variable_key");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_link_targets_drip_step_id_variable_key_key" ON "tracked_link_targets"("drip_step_id", "variable_key");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_links_code_key" ON "tracked_links"("code");

-- CreateIndex
CREATE INDEX "tracked_links_target_id_idx" ON "tracked_links"("target_id");

-- CreateIndex
CREATE INDEX "tracked_links_contact_id_idx" ON "tracked_links"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_links_message_id_target_id_key" ON "tracked_links"("message_id", "target_id");

-- CreateIndex
CREATE INDEX "link_clicks_campaign_id_contact_id_idx" ON "link_clicks"("campaign_id", "contact_id");

-- CreateIndex
CREATE INDEX "link_clicks_drip_step_id_contact_id_idx" ON "link_clicks"("drip_step_id", "contact_id");

-- CreateIndex
CREATE INDEX "link_clicks_target_id_idx" ON "link_clicks"("target_id");

-- CreateIndex
CREATE INDEX "link_clicks_contact_id_idx" ON "link_clicks"("contact_id");

-- CreateIndex
CREATE INDEX "link_clicks_clicked_at_idx" ON "link_clicks"("clicked_at");

-- CreateIndex
CREATE INDEX "campaign_retry_rounds_status_due_at_idx" ON "campaign_retry_rounds"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_retry_rounds_campaign_id_round_key" ON "campaign_retry_rounds"("campaign_id", "round");

-- CreateIndex
CREATE INDEX "drips_status_idx" ON "drips"("status");

-- CreateIndex
CREATE INDEX "drip_steps_drip_id_idx" ON "drip_steps"("drip_id");

-- CreateIndex
CREATE INDEX "drip_triggers_drip_id_idx" ON "drip_triggers"("drip_id");

-- CreateIndex
CREATE INDEX "drip_triggers_kind_idx" ON "drip_triggers"("kind");

-- CreateIndex
CREATE INDEX "drip_enrolments_status_next_due_at_idx" ON "drip_enrolments"("status", "next_due_at");

-- CreateIndex
CREATE INDEX "drip_enrolments_contact_id_status_idx" ON "drip_enrolments"("contact_id", "status");

-- CreateIndex
CREATE INDEX "drip_enrolments_drip_id_status_idx" ON "drip_enrolments"("drip_id", "status");

-- CreateIndex
CREATE INDEX "drip_step_sends_step_id_idx" ON "drip_step_sends"("step_id");

-- CreateIndex
CREATE INDEX "drip_step_sends_message_id_idx" ON "drip_step_sends"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "drip_step_sends_enrolment_id_step_id_key" ON "drip_step_sends"("enrolment_id", "step_id");

-- CreateIndex
CREATE INDEX "drip_events_occurred_at_idx" ON "drip_events"("occurred_at");

-- CreateIndex
CREATE INDEX "messages_drip_step_id_idx" ON "messages"("drip_step_id");

-- CreateIndex
CREATE INDEX "messages_drip_enrolment_id_idx" ON "messages"("drip_enrolment_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_drip_enrolment_id_fkey" FOREIGN KEY ("drip_enrolment_id") REFERENCES "drip_enrolments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_drip_step_id_fkey" FOREIGN KEY ("drip_step_id") REFERENCES "drip_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_link_targets" ADD CONSTRAINT "tracked_link_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_link_targets" ADD CONSTRAINT "tracked_link_targets_drip_step_id_fkey" FOREIGN KEY ("drip_step_id") REFERENCES "drip_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "tracked_link_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_tracked_link_id_fkey" FOREIGN KEY ("tracked_link_id") REFERENCES "tracked_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_retry_rounds" ADD CONSTRAINT "campaign_retry_rounds_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drips" ADD CONSTRAINT "drips_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drips" ADD CONSTRAINT "drips_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_drip_id_fkey" FOREIGN KEY ("drip_id") REFERENCES "drips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_header_media_asset_id_fkey" FOREIGN KEY ("header_media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_triggers" ADD CONSTRAINT "drip_triggers_drip_id_fkey" FOREIGN KEY ("drip_id") REFERENCES "drips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_triggers" ADD CONSTRAINT "drip_triggers_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_triggers" ADD CONSTRAINT "drip_triggers_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_enrolments" ADD CONSTRAINT "drip_enrolments_drip_id_fkey" FOREIGN KEY ("drip_id") REFERENCES "drips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_enrolments" ADD CONSTRAINT "drip_enrolments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_enrolments" ADD CONSTRAINT "drip_enrolments_joined_by_id_fkey" FOREIGN KEY ("joined_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_step_sends" ADD CONSTRAINT "drip_step_sends_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "drip_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_step_sends" ADD CONSTRAINT "drip_step_sends_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "drip_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drip_step_sends" ADD CONSTRAINT "drip_step_sends_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A tracked link target belongs to exactly one campaign or one drip step.
ALTER TABLE "tracked_link_targets" ADD CONSTRAINT "tracked_link_targets_one_owner" CHECK (("campaign_id" IS NULL) <> ("drip_step_id" IS NULL));

-- Retry plans have 0 to 3 rounds (FR-012).
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_retry_rounds_range" CHECK ("retry_rounds" BETWEEN 0 AND 3);
ALTER TABLE "campaign_retry_rounds" ADD CONSTRAINT "campaign_retry_rounds_round_range" CHECK ("round" BETWEEN 1 AND 3);

-- Drip names are unique among drips that are not archived (citext: ignoring case).
CREATE UNIQUE INDEX "drips_name_live_key" ON "drips"("name") WHERE "status" <> 'ARCHIVED';

-- Quiet hours are set as a pair of "HH:MM" times, or not at all.
ALTER TABLE "drips" ADD CONSTRAINT "drips_quiet_hours_pair" CHECK (("quiet_from" IS NULL) = ("quiet_to" IS NULL));
ALTER TABLE "drips" ADD CONSTRAINT "drips_quiet_hours_format" CHECK (
    ("quiet_from" IS NULL OR "quiet_from" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND ("quiet_to" IS NULL OR "quiet_to" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

-- One live step per position in a drip. Reordering moves positions in two passes, so the range
-- (1 to 10) is checked by the service, not here.
CREATE UNIQUE INDEX "drip_steps_position_live_key" ON "drip_steps"("drip_id", "position") WHERE "deleted_at" IS NULL;
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_wait_range" CHECK ("wait_minutes" BETWEEN 0 AND 43200);

-- A contact is at most once at a time in a drip (FR-026).
CREATE UNIQUE INDEX "drip_enrolments_one_active_key" ON "drip_enrolments"("drip_id", "contact_id") WHERE "status" = 'ACTIVE';
