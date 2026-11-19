-- Feature 002 live chat (specs/002-team-inbox/data-model.md, T013). Generated with prisma migrate diff,
-- plus the citext extension, check constraints and the lead_source back-fill.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('ACTIVE', 'REQUESTING', 'INTERVENED');

-- CreateEnum
CREATE TYPE "ChatItemKind" AS ENUM ('INBOUND', 'SESSION_OUT', 'MESSAGE_REF', 'NOTE');

-- CreateEnum
CREATE TYPE "ChatOrigin" AS ENUM ('CUSTOMER', 'MEMBER', 'AUTOMATIC', 'CAMPAIGN', 'API');

-- CreateEnum
CREATE TYPE "ChatContentType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACTS', 'BUTTON_REPLY', 'LIST_REPLY', 'FORM_REPLY', 'REACTION', 'TEMPLATE', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "MediaState" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "JourneyEventType" AS ENUM ('REQUESTED', 'INTERVENED', 'TRANSFERRED', 'RESOLVED', 'AUTO_RESOLVED', 'TAG_ADDED', 'TAG_REMOVED', 'ATTRIBUTE_CHANGED', 'CONSENT_CHANGED', 'BLOCKED', 'UNBLOCKED', 'FIRST_MESSAGE_TAG_CHANGED');

-- CreateEnum
CREATE TYPE "JourneyActor" AS ENUM ('MEMBER', 'CUSTOMER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentRuleKind" AS ENUM ('TAG', 'ATTRIBUTE');

-- CreateEnum
CREATE TYPE "CannedType" AS ENUM ('TEXT', 'MEDIA');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MediaPurpose" ADD VALUE 'LIBRARY';
ALTER TYPE "MediaPurpose" ADD VALUE 'INBOUND';

-- AlterEnum
ALTER TYPE "MessageOrigin" ADD VALUE 'INBOX';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'INBOX_REQUESTING';
ALTER TYPE "NotificationType" ADD VALUE 'INBOX_TRANSFERRED';
ALTER TYPE "NotificationType" ADD VALUE 'INBOX_MENTION';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "blocked_at" TIMESTAMPTZ,
ADD COLUMN     "blocked_by_id" UUID,
ADD COLUMN     "first_message_tag_id" UUID,
ADD COLUMN     "lead_source" VARCHAR(80);

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "display_name" VARCHAR(240),
ADD COLUMN     "uploaded_by_id" UUID;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "automatic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sent_by_user_id" UUID;

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "contact_id" UUID,
    "number_id" UUID NOT NULL,
    "state" "ConversationState" NOT NULL DEFAULT 'ACTIVE',
    "intervened_by_id" UUID,
    "intervened_at" TIMESTAMPTZ,
    "last_customer_message_at" TIMESTAMPTZ,
    "last_inbound_at" TIMESTAMPTZ,
    "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_preview" VARCHAR(120),
    "unresolved_requests" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "kind" "ChatItemKind" NOT NULL,
    "origin" "ChatOrigin" NOT NULL,
    "content_type" "ChatContentType" NOT NULL,
    "text" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "media_asset_id" UUID,
    "media_state" "MediaState",
    "message_id" UUID,
    "wa_message_id" TEXT,
    "reply_to_wa_id" TEXT,
    "status" "MessageStatus",
    "failure_code" INTEGER,
    "failure_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_by_user_id" UUID,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "sent_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "read_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_openings" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ NOT NULL,
    "first_human_reply_at" TIMESTAMPTZ,
    "first_responder_id" UUID,
    "intervened_at" TIMESTAMPTZ,
    "intervened_by_id" UUID,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by_id" UUID,
    "welcome_sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_events" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "type" "JourneyEventType" NOT NULL,
    "actor_type" "JourneyActor" NOT NULL,
    "actor_user_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_read_markers" (
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_read_markers_pkey" PRIMARY KEY ("user_id","conversation_id")
);

-- CreateTable
CREATE TABLE "live_chat_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "working_hours" JSONB NOT NULL DEFAULT '{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],"thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[],"sun":[]}',
    "welcome_enabled" BOOLEAN NOT NULL DEFAULT false,
    "welcome_content" JSONB,
    "off_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
    "off_hours_content" JSONB,
    "human_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auto_resolve" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "live_chat_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_rules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AgentRuleKind" NOT NULL,
    "tag_id" UUID,
    "attribute_key" TEXT,
    "attribute_value" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_messages" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "type" "CannedType" NOT NULL,
    "text" VARCHAR(4096),
    "variable_fallbacks" JSONB NOT NULL DEFAULT '{}',
    "media_asset_id" UUID,
    "media_url" TEXT,
    "file_name" VARCHAR(240),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "canned_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_message_favorites" (
    "user_id" UUID NOT NULL,
    "canned_message_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canned_message_favorites_pkey" PRIMARY KEY ("user_id","canned_message_id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "sound_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "last_success_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_state_last_activity_at_idx" ON "conversations"("state", "last_activity_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_intervened_by_id_idx" ON "conversations"("intervened_by_id");

-- CreateIndex
CREATE INDEX "conversations_number_id_last_activity_at_idx" ON "conversations"("number_id", "last_activity_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_last_customer_message_at_idx" ON "conversations"("last_customer_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_contact_id_number_id_key" ON "conversations"("contact_id", "number_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_message_id_key" ON "chat_messages"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_wa_message_id_key" ON "chat_messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_occurred_at_id_idx" ON "chat_messages"("conversation_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "conversation_openings_conversation_id_opened_at_idx" ON "conversation_openings"("conversation_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "conversation_openings_opened_at_idx" ON "conversation_openings"("opened_at");

-- CreateIndex
CREATE INDEX "conversation_events_conversation_id_occurred_at_idx" ON "conversation_events"("conversation_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "chat_read_markers_conversation_id_idx" ON "chat_read_markers"("conversation_id");

-- CreateIndex
CREATE INDEX "agent_rules_user_id_idx" ON "agent_rules"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_messages_name_key" ON "canned_messages"("name");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_endpoint_key" ON "push_devices"("endpoint");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE INDEX "media_assets_purpose_created_at_idx" ON "media_assets"("purpose", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_blocked_by_id_fkey" FOREIGN KEY ("blocked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_first_message_tag_id_fkey" FOREIGN KEY ("first_message_tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_intervened_by_id_fkey" FOREIGN KEY ("intervened_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_openings" ADD CONSTRAINT "conversation_openings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_openings" ADD CONSTRAINT "conversation_openings_first_responder_id_fkey" FOREIGN KEY ("first_responder_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_openings" ADD CONSTRAINT "conversation_openings_intervened_by_id_fkey" FOREIGN KEY ("intervened_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_openings" ADD CONSTRAINT "conversation_openings_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_read_markers" ADD CONSTRAINT "chat_read_markers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_read_markers" ADD CONSTRAINT "chat_read_markers_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_chat_settings" ADD CONSTRAINT "live_chat_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_rules" ADD CONSTRAINT "agent_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_rules" ADD CONSTRAINT "agent_rules_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_rules" ADD CONSTRAINT "agent_rules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_messages" ADD CONSTRAINT "canned_messages_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_messages" ADD CONSTRAINT "canned_messages_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_message_favorites" ADD CONSTRAINT "canned_message_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canned_message_favorites" ADD CONSTRAINT "canned_message_favorites_canned_message_id_fkey" FOREIGN KEY ("canned_message_id") REFERENCES "canned_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Invariants Prisma cannot express (data-model §1)
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_intervened_owner_check" CHECK ("state" <> 'INTERVENED' OR "intervened_by_id" IS NOT NULL);
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_message_ref_check" CHECK ("kind" <> 'MESSAGE_REF' OR "message_id" IS NOT NULL);
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_note_origin_check" CHECK ("kind" <> 'NOTE' OR "origin" = 'MEMBER');
ALTER TABLE "live_chat_settings" ADD CONSTRAINT "live_chat_settings_singleton_check" CHECK ("id" = 1);

-- Profile source for existing contacts (FR-033)
UPDATE "contacts" SET "lead_source" = CASE "consent_source" WHEN 'API' THEN 'API' WHEN 'UPLOAD_CONFIRMATION' THEN 'Campaign upload' WHEN 'IMPORT' THEN 'Import' END WHERE "lead_source" IS NULL;
