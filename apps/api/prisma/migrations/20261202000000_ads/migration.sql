-- Feature 007: the ads manager (specs/007-ads-manager/data-model.md, T005).
-- Generated with prisma migrate diff from the schema, plus the hand-written tail at the end.

-- CreateEnum
CREATE TYPE "AdsConnectionStatus" AS ENUM ('CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "AdGoal" AS ENUM ('CHATS', 'LEADS', 'WEBSITE');

-- CreateEnum
CREATE TYPE "AdCampaignStatus" AS ENUM ('DRAFT', 'SUBMITTING', 'IN_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ENDED', 'ERROR');

-- CreateEnum
CREATE TYPE "AdSpecialCategory" AS ENUM ('NONE', 'CREDIT', 'EMPLOYMENT', 'HOUSING', 'SOCIAL_ISSUES');

-- CreateEnum
CREATE TYPE "AdMediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "AdVersionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ENDED');

-- CreateEnum
CREATE TYPE "AdAudienceKind" AS ENUM ('CUSTOM', 'LOOKALIKE');

-- CreateEnum
CREATE TYPE "AdAudienceStatus" AS ENUM ('SYNCING', 'READY', 'TOO_SMALL', 'ERROR');

-- CreateEnum
CREATE TYPE "AdLeadStatus" AS ENUM ('PROCESSED', 'NO_PHONE', 'INVALID_PHONE', 'FAILED');

-- AlterEnum
ALTER TYPE "ConsentSource" ADD VALUE 'LEAD_FORM';

-- AlterEnum
ALTER TYPE "MessageOrigin" ADD VALUE 'ADS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ADS_CONNECTION_ERROR';
ALTER TYPE "NotificationType" ADD VALUE 'AD_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'AD_NOT_DELIVERING';
ALTER TYPE "NotificationType" ADD VALUE 'ADS_SPEND_CAP_REACHED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JourneyEventType" ADD VALUE 'AD_CHAT_STARTED';
ALTER TYPE "JourneyEventType" ADD VALUE 'LEAD_RECEIVED';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "ad_lead_id" UUID;

-- CreateTable
CREATE TABLE "ads_connections" (
    "id" UUID NOT NULL,
    "ad_account_id" VARCHAR(40) NOT NULL,
    "ad_account_name" VARCHAR(200) NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "page_name" VARCHAR(200) NOT NULL,
    "token_enc" TEXT NOT NULL,
    "page_token_enc" TEXT,
    "currency" CHAR(3) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "status" "AdsConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "checks" JSONB NOT NULL DEFAULT '{}',
    "checked_at" TIMESTAMPTZ,
    "monthly_cap_minor" BIGINT,
    "capped_month" CHAR(7),
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ads_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_campaigns" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "goal" "AdGoal" NOT NULL,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "number_id" UUID,
    "prefilled_message" VARCHAR(300),
    "welcome_sequence_id" VARCHAR(40),
    "lead_form_id" UUID,
    "website_url" VARCHAR(2000),
    "link_code" CHAR(10),
    "targeting" JSONB NOT NULL,
    "placements" JSONB NOT NULL,
    "special_category" "AdSpecialCategory" NOT NULL DEFAULT 'NONE',
    "daily_budget_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ,
    "flow_id" UUID,
    "tag_id" UUID,
    "meta_campaign_id" VARCHAR(40),
    "meta_adset_id" VARCHAR(40),
    "meta_status" VARCHAR(40),
    "last_error" VARCHAR(500),
    "synced_at" TIMESTAMPTZ,
    "submitted_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_versions" (
    "id" UUID NOT NULL,
    "ad_campaign_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "media_kind" "AdMediaKind" NOT NULL,
    "meta_image_hash" VARCHAR(100),
    "meta_video_id" VARCHAR(100),
    "primary_text" VARCHAR(2200) NOT NULL,
    "headline" VARCHAR(255) NOT NULL,
    "call_to_action" VARCHAR(40) NOT NULL,
    "meta_creative_id" VARCHAR(40),
    "meta_ad_id" VARCHAR(40),
    "status" "AdVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "review_feedback" VARCHAR(1000),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ad_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_result_days" (
    "id" UUID NOT NULL,
    "ad_campaign_id" UUID NOT NULL,
    "ad_version_id" UUID,
    "day" DATE NOT NULL,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "reach" BIGINT NOT NULL DEFAULT 0,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "spend_minor" BIGINT NOT NULL DEFAULT 0,
    "meta_conversations" INTEGER NOT NULL DEFAULT 0,
    "meta_leads" INTEGER NOT NULL DEFAULT 0,
    "read_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ad_result_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_chat_starts" (
    "id" UUID NOT NULL,
    "meta_ad_id" VARCHAR(40) NOT NULL,
    "ad_campaign_id" UUID,
    "ad_version_id" UUID,
    "contact_id" UUID,
    "conversation_id" UUID,
    "new_contact" BOOLEAN NOT NULL,
    "headline" VARCHAR(500),
    "body" VARCHAR(500),
    "media_url" VARCHAR(2000),
    "source_url" VARCHAR(2000),
    "ctwa_clid" VARCHAR(200),
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_chat_starts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_audiences" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "kind" "AdAudienceKind" NOT NULL,
    "source" JSONB,
    "origin_audience_id" UUID,
    "lookalike_country" CHAR(2),
    "lookalike_ratio" DECIMAL(4,2),
    "meta_audience_id" VARCHAR(40),
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "status" "AdAudienceStatus" NOT NULL DEFAULT 'SYNCING',
    "last_error" VARCHAR(500),
    "synced_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ad_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_audience_members" (
    "audience_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "phone_hash" CHAR(64) NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_audience_members_pkey" PRIMARY KEY ("audience_id","contact_id")
);

-- CreateTable
CREATE TABLE "ad_lead_forms" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "privacy_url" VARCHAR(2000) NOT NULL,
    "consent_text" VARCHAR(300) NOT NULL,
    "tag_id" UUID,
    "welcome_template_id" UUID,
    "welcome_mapping" JSONB NOT NULL DEFAULT '{}',
    "meta_form_id" VARCHAR(40),
    "last_lead_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ad_lead_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_leads" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "meta_lead_id" VARCHAR(40) NOT NULL,
    "meta_ad_id" VARCHAR(40),
    "ad_campaign_id" UUID,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "phone_e164" VARCHAR(16),
    "email" VARCHAR(320),
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "contact_id" UUID,
    "status" "AdLeadStatus" NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_link_opens" (
    "id" UUID NOT NULL,
    "ad_campaign_id" UUID NOT NULL,
    "device" "ClickDevice" NOT NULL,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_link_opens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_campaigns_link_code_key" ON "ad_campaigns"("link_code");

-- CreateIndex
CREATE INDEX "ad_campaigns_status_idx" ON "ad_campaigns"("status");

-- CreateIndex
CREATE INDEX "ad_campaigns_flow_id_idx" ON "ad_campaigns"("flow_id");

-- CreateIndex
CREATE INDEX "ad_campaigns_tag_id_idx" ON "ad_campaigns"("tag_id");

-- CreateIndex
CREATE INDEX "ad_campaigns_number_id_idx" ON "ad_campaigns"("number_id");

-- CreateIndex
CREATE INDEX "ad_campaigns_lead_form_id_idx" ON "ad_campaigns"("lead_form_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_versions_meta_ad_id_key" ON "ad_versions"("meta_ad_id");

-- CreateIndex
CREATE INDEX "ad_versions_media_asset_id_idx" ON "ad_versions"("media_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_versions_ad_campaign_id_position_key" ON "ad_versions"("ad_campaign_id", "position");

-- CreateIndex
CREATE INDEX "ad_result_days_ad_campaign_id_day_idx" ON "ad_result_days"("ad_campaign_id", "day");

-- CreateIndex
CREATE INDEX "ad_result_days_ad_version_id_idx" ON "ad_result_days"("ad_version_id");

-- CreateIndex
CREATE INDEX "ad_result_days_day_idx" ON "ad_result_days"("day");

-- CreateIndex
CREATE INDEX "ad_chat_starts_ad_campaign_id_started_at_idx" ON "ad_chat_starts"("ad_campaign_id", "started_at");

-- CreateIndex
CREATE INDEX "ad_chat_starts_ad_version_id_idx" ON "ad_chat_starts"("ad_version_id");

-- CreateIndex
CREATE INDEX "ad_chat_starts_contact_id_idx" ON "ad_chat_starts"("contact_id");

-- CreateIndex
CREATE INDEX "ad_chat_starts_conversation_id_idx" ON "ad_chat_starts"("conversation_id");

-- CreateIndex
CREATE INDEX "ad_chat_starts_meta_ad_id_idx" ON "ad_chat_starts"("meta_ad_id");

-- CreateIndex
CREATE INDEX "ad_chat_starts_started_at_idx" ON "ad_chat_starts"("started_at");

-- CreateIndex
CREATE INDEX "ad_audiences_origin_audience_id_idx" ON "ad_audiences"("origin_audience_id");

-- CreateIndex
CREATE INDEX "ad_audience_members_contact_id_idx" ON "ad_audience_members"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_lead_forms_name_key" ON "ad_lead_forms"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ad_lead_forms_meta_form_id_key" ON "ad_lead_forms"("meta_form_id");

-- CreateIndex
CREATE INDEX "ad_lead_forms_tag_id_idx" ON "ad_lead_forms"("tag_id");

-- CreateIndex
CREATE INDEX "ad_lead_forms_welcome_template_id_idx" ON "ad_lead_forms"("welcome_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_leads_meta_lead_id_key" ON "ad_leads"("meta_lead_id");

-- CreateIndex
CREATE INDEX "ad_leads_form_id_submitted_at_idx" ON "ad_leads"("form_id", "submitted_at");

-- CreateIndex
CREATE INDEX "ad_leads_ad_campaign_id_idx" ON "ad_leads"("ad_campaign_id");

-- CreateIndex
CREATE INDEX "ad_leads_contact_id_idx" ON "ad_leads"("contact_id");

-- CreateIndex
CREATE INDEX "ad_leads_received_at_idx" ON "ad_leads"("received_at");

-- CreateIndex
CREATE INDEX "ad_link_opens_ad_campaign_id_opened_at_idx" ON "ad_link_opens"("ad_campaign_id", "opened_at");

-- CreateIndex
CREATE INDEX "ad_link_opens_opened_at_idx" ON "ad_link_opens"("opened_at");

-- CreateIndex
CREATE INDEX "messages_ad_lead_id_idx" ON "messages"("ad_lead_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_ad_lead_id_fkey" FOREIGN KEY ("ad_lead_id") REFERENCES "ad_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_connections" ADD CONSTRAINT "ads_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_lead_form_id_fkey" FOREIGN KEY ("lead_form_id") REFERENCES "ad_lead_forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_versions" ADD CONSTRAINT "ad_versions_ad_campaign_id_fkey" FOREIGN KEY ("ad_campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_versions" ADD CONSTRAINT "ad_versions_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_result_days" ADD CONSTRAINT "ad_result_days_ad_campaign_id_fkey" FOREIGN KEY ("ad_campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_result_days" ADD CONSTRAINT "ad_result_days_ad_version_id_fkey" FOREIGN KEY ("ad_version_id") REFERENCES "ad_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_chat_starts" ADD CONSTRAINT "ad_chat_starts_ad_campaign_id_fkey" FOREIGN KEY ("ad_campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_chat_starts" ADD CONSTRAINT "ad_chat_starts_ad_version_id_fkey" FOREIGN KEY ("ad_version_id") REFERENCES "ad_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_chat_starts" ADD CONSTRAINT "ad_chat_starts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_chat_starts" ADD CONSTRAINT "ad_chat_starts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_origin_audience_id_fkey" FOREIGN KEY ("origin_audience_id") REFERENCES "ad_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_audience_members" ADD CONSTRAINT "ad_audience_members_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "ad_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_welcome_template_id_fkey" FOREIGN KEY ("welcome_template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "ad_lead_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_ad_campaign_id_fkey" FOREIGN KEY ("ad_campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_link_opens" ADD CONSTRAINT "ad_link_opens_ad_campaign_id_fkey" FOREIGN KEY ("ad_campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written (feature 007, data-model.md): one connection row, result days unique with NULL version
-- rows, a contact once a day per ad, names unique while not deleted, and check constraints.
CREATE UNIQUE INDEX "ads_connections_one_row" ON "ads_connections" ((true));
CREATE UNIQUE INDEX "ad_result_days_key" ON "ad_result_days" ("ad_campaign_id", "ad_version_id", "day") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "ad_chat_starts_daily_key" ON "ad_chat_starts" ("meta_ad_id", "contact_id", (("started_at" AT TIME ZONE 'UTC')::date));
CREATE UNIQUE INDEX "ad_campaigns_name_live_key" ON "ad_campaigns" ("name") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "ad_audiences_name_live_key" ON "ad_audiences" ("name") WHERE "deleted_at" IS NULL;
ALTER TABLE "ad_versions" ADD CONSTRAINT "ad_versions_position_check" CHECK ("position" BETWEEN 1 AND 5);
ALTER TABLE "ad_audiences" ADD CONSTRAINT "ad_audiences_ratio_check" CHECK ("lookalike_ratio" IS NULL OR "lookalike_ratio" BETWEEN 0.01 AND 0.10);
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_budget_check" CHECK ("daily_budget_minor" > 0);
