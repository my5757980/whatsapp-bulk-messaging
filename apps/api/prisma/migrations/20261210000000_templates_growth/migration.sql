-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('STANDARD', 'CAROUSEL', 'LIMITED_TIME_OFFER', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "TtlAppliedBy" AS ENUM ('META', 'PLATFORM');

-- CreateEnum
CREATE TYPE "ExpiredReason" AS ENUM ('EXPIRED_BEFORE_SENDING', 'NOT_DELIVERED_IN_TIME', 'OFFER_ENDED');

-- CreateEnum
CREATE TYPE "ChatLinkSource" AS ENUM ('MANUAL', 'WIDGET');

-- CreateEnum
CREATE TYPE "ChatWidgetStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- AlterEnum
ALTER TYPE "MessageOrigin" ADD VALUE 'OTP';

-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'EXPIRED';

-- AlterEnum
ALTER TYPE "MessageEventType" ADD VALUE 'EXPIRED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SkipReason" ADD VALUE 'OFFER_CODE_MISSING';
ALTER TYPE "SkipReason" ADD VALUE 'MEDIA_URL_MISSING';

-- DropIndex
DROP INDEX "messages_campaign_id_contact_id_key";

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "kind" "TemplateKind" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "options" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "ttl_applied_by" "TtlAppliedBy",
ADD COLUMN     "ttl_seconds" INTEGER;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "allow_duplicate_rows" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "card_media" JSONB,
ADD COLUMN     "launched_by_id" UUID,
ADD COLUMN     "offer_config" JSONB;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "copy_index" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "expired_reason" "ExpiredReason",
ADD COLUMN     "expires_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "chat_links" ADD COLUMN     "source" "ChatLinkSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "widget_id" UUID,
ADD COLUMN     "widget_rule_id" VARCHAR(40);

-- AlterTable
ALTER TABLE "chat_link_opens" ADD COLUMN     "page" VARCHAR(200);

-- CreateTable
CREATE TABLE "otp_settings" (
    "id" UUID NOT NULL,
    "default_template_id" UUID,
    "default_number_id" UUID,
    "limit_per_phone" INTEGER NOT NULL DEFAULT 5,
    "limit_window_minutes" INTEGER NOT NULL DEFAULT 15,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "otp_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_widgets" (
    "id" UUID NOT NULL,
    "key" CHAR(12) NOT NULL,
    "name" CITEXT NOT NULL,
    "number_id" UUID NOT NULL,
    "look" JSONB NOT NULL,
    "brand_name" VARCHAR(60) NOT NULL,
    "brand_image_asset_id" UUID,
    "greeting" VARCHAR(300) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "status" "ChatWidgetStatus" NOT NULL DEFAULT 'ACTIVE',
    "disconnect_notified_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_widgets_key_key" ON "chat_widgets"("key");

-- CreateIndex
CREATE UNIQUE INDEX "chat_widgets_name_key" ON "chat_widgets"("name");

-- CreateIndex
CREATE INDEX "chat_widgets_number_id_idx" ON "chat_widgets"("number_id");

-- CreateIndex
CREATE INDEX "consent_events_created_at_idx" ON "consent_events"("created_at");

-- CreateIndex
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at");

-- CreateIndex
CREATE INDEX "messages_status_expires_at_idx" ON "messages"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_campaign_id_contact_id_copy_index_key" ON "messages"("campaign_id", "contact_id", "copy_index");

-- CreateIndex
CREATE INDEX "chat_links_widget_id_idx" ON "chat_links"("widget_id");

-- CreateIndex
CREATE INDEX "chat_link_opens_chat_link_id_page_idx" ON "chat_link_opens"("chat_link_id", "page");

-- AddForeignKey
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_widget_id_fkey" FOREIGN KEY ("widget_id") REFERENCES "chat_widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_settings" ADD CONSTRAINT "otp_settings_default_template_id_fkey" FOREIGN KEY ("default_template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_settings" ADD CONSTRAINT "otp_settings_default_number_id_fkey" FOREIGN KEY ("default_number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_brand_image_asset_id_fkey" FOREIGN KEY ("brand_image_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------- Hand-written (feature 009, data-model.md) ----------

-- One row of code settings.
CREATE UNIQUE INDEX "otp_settings_one_row" ON "otp_settings" ((true));

-- Checks.
ALTER TABLE "messages" ADD CONSTRAINT "messages_copy_index_check" CHECK ("copy_index" >= 0);
ALTER TABLE "otp_settings" ADD CONSTRAINT "otp_settings_limit_check" CHECK ("limit_per_phone" BETWEEN 1 AND 50 AND "limit_window_minutes" BETWEEN 1 AND 1440);
ALTER TABLE "templates" ADD CONSTRAINT "templates_ttl_seconds_check" CHECK ("ttl_seconds" IS NULL OR "ttl_seconds" BETWEEN 30 AND 2592000);

-- Who launched each campaign (R14): the latest campaign.launched audit entry, else the creator.
UPDATE "campaigns" c
   SET "launched_by_id" = COALESCE(
         (SELECT a."actor_user_id" FROM "audit_logs" a
           WHERE a."action" = 'campaign.launched' AND a."target_type" = 'campaign' AND a."target_id" = c."id"::text AND a."actor_user_id" IS NOT NULL
           ORDER BY a."created_at" DESC LIMIT 1),
         c."created_by_id")
 WHERE c."launched_at" IS NOT NULL;
