-- Initial schema for 001-whatsapp-bulk-messaging (T026).
-- pg_trgm powers the trigram search indexes on contacts (name, phone).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'AGENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "QualityRating" AS ENUM ('GREEN', 'YELLOW', 'RED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('IMPORT', 'UPLOAD_CONFIRMATION', 'API', 'KEYWORD', 'MANUAL');

-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('CONTACTS', 'CAMPAIGN_AUDIENCE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "ParameterFormat" AS ENUM ('POSITIONAL', 'NAMED');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('TEMPLATE_SAMPLE', 'CAMPAIGN_HEADER');

-- CreateEnum
CREATE TYPE "CampaignState" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AudienceType" AS ENUM ('FILTER', 'ALL_OPTED_IN', 'UPLOAD', 'RETARGET');

-- CreateEnum
CREATE TYPE "RetargetStatus" AS ENUM ('FAILED', 'NOT_READ', 'READ', 'DELIVERED');

-- CreateEnum
CREATE TYPE "MessageOrigin" AS ENUM ('CAMPAIGN', 'API');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('OPTED_OUT', 'NO_OPT_IN', 'INVALID_NUMBER', 'DUPLICATE', 'MISSING_VARIABLE');

-- CreateEnum
CREATE TYPE "MessageEventType" AS ENUM ('QUEUED', 'SENT_ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RETRY_SCHEDULED', 'SKIPPED', 'CANCELLED', 'REQUEUED');

-- CreateEnum
CREATE TYPE "RateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CAMPAIGN_COMPLETED', 'CAMPAIGN_AUTO_PAUSED', 'QUALITY_DROPPED', 'CREDENTIALS_FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_api_key_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "default_country_code" CHAR(2) NOT NULL DEFAULT 'US',
    "default_timezone" TEXT NOT NULL DEFAULT 'UTC',
    "opt_out_keywords" TEXT[] DEFAULT ARRAY['STOP', 'UNSUBSCRIBE']::TEXT[],
    "opt_in_keywords" TEXT[] DEFAULT ARRAY['START']::TEXT[],
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_numbers" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone_number" TEXT NOT NULL,
    "verified_name" TEXT NOT NULL,
    "connection_status" "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "quality_rating" "QualityRating" NOT NULL DEFAULT 'UNKNOWN',
    "messaging_limit_tier" TEXT,
    "throughput_level" TEXT,
    "send_rate_per_second" INTEGER NOT NULL DEFAULT 20,
    "sending_enabled" BOOLEAN NOT NULL DEFAULT true,
    "access_token_enc" TEXT NOT NULL,
    "last_synced_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "name" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "consent_status" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "consent_source" "ConsentSource",
    "consent_source_note" TEXT,
    "consent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "attribute_definitions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "AttributeType" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_events" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "note" TEXT,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "campaign_id" UUID,
    "file_key" TEXT NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "opt_in_source_note" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'QUEUED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error_file_key" TEXT,
    "error" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_upload_rows" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "campaign_upload_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "waba_id" TEXT NOT NULL,
    "meta_template_id" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" "TemplateCategory" NOT NULL,
    "parameter_format" "ParameterFormat" NOT NULL DEFAULT 'POSITIONAL',
    "components" JSONB NOT NULL DEFAULT '[]',
    "variables" JSONB NOT NULL DEFAULT '[]',
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "header_media_asset_id" UUID,
    "last_synced_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "meta_header_handle" TEXT,
    "meta_media_ids" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "number_id" UUID,
    "template_id" UUID,
    "state" "CampaignState" NOT NULL DEFAULT 'DRAFT',
    "audience_type" "AudienceType" NOT NULL DEFAULT 'UPLOAD',
    "audience_filter" JSONB,
    "variable_mapping" JSONB NOT NULL DEFAULT '{}',
    "header_media_asset_id" UUID,
    "scheduled_at" TIMESTAMPTZ,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "source_campaign_id" UUID,
    "retarget_status" "RetargetStatus",
    "paused_reason" TEXT,
    "launched_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "totals" JSONB NOT NULL DEFAULT '{}',
    "estimated_cost_usd_micros" BIGINT NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "origin" "MessageOrigin" NOT NULL,
    "campaign_id" UUID,
    "api_key_id" UUID,
    "contact_id" UUID,
    "phone_e164" TEXT,
    "recipient_country" CHAR(2) NOT NULL,
    "number_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "resolved_params" JSONB NOT NULL DEFAULT '{}',
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "skip_reason" "SkipReason",
    "failure_code" INTEGER,
    "failure_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "wa_message_id" TEXT,
    "pricing_category" TEXT,
    "billable" BOOLEAN,
    "cost_usd_micros" BIGINT,
    "queued_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "read_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_events" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "type" "MessageEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature_valid" BOOLEAN NOT NULL,
    "payload" JSONB,
    "processed_at" TIMESTAMPTZ,
    "error" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_entries" (
    "id" UUID NOT NULL,
    "category" "RateCategory" NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "price_usd_micros" BIGINT NOT NULL,
    "effective_from" DATE NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_card_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" CHAR(8) NOT NULL,
    "key_hash" TEXT NOT NULL,
    "last4" CHAR(4) NOT NULL,
    "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 60,
    "created_by_id" UUID NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "api_key_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "request_hash" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_phone_number_id_key" ON "whatsapp_numbers"("phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_phone_e164_key" ON "contacts"("phone_e164");

-- CreateIndex
CREATE INDEX "contacts_consent_status_idx" ON "contacts"("consent_status");

-- CreateIndex
CREATE INDEX "contacts_attributes_idx" ON "contacts" USING GIN ("attributes");

-- CreateIndex
CREATE INDEX "contacts_name_trgm_idx" ON "contacts" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "contacts_phone_trgm_idx" ON "contacts" USING GIN ("phone_e164" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "contact_tags_tag_id_idx" ON "contact_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_key_key" ON "attribute_definitions"("key");

-- CreateIndex
CREATE INDEX "consent_events_contact_id_idx" ON "consent_events"("contact_id");

-- CreateIndex
CREATE INDEX "import_jobs_campaign_id_idx" ON "import_jobs"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_upload_rows_campaign_id_phone_e164_key" ON "campaign_upload_rows"("campaign_id", "phone_e164");

-- CreateIndex
CREATE INDEX "templates_status_idx" ON "templates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "templates_waba_id_name_language_key" ON "templates"("waba_id", "name", "language");

-- CreateIndex
CREATE INDEX "campaigns_state_idx" ON "campaigns"("state");

-- CreateIndex
CREATE UNIQUE INDEX "messages_wa_message_id_key" ON "messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "messages_campaign_id_status_idx" ON "messages"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "messages_api_key_id_created_at_idx" ON "messages"("api_key_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_campaign_id_contact_id_key" ON "messages"("campaign_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_events_dedupe_key_key" ON "message_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "message_events_message_id_idx" ON "message_events"("message_id");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_entries_category_country_code_effective_from_key" ON "rate_card_entries"("category", "country_code", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_prefix_idx" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_api_key_id_key_key" ON "idempotency_records"("api_key_id", "key");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_api_key_id_fkey" FOREIGN KEY ("actor_api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_upload_rows" ADD CONSTRAINT "campaign_upload_rows_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_header_media_asset_id_fkey" FOREIGN KEY ("header_media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_header_media_asset_id_fkey" FOREIGN KEY ("header_media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_source_campaign_id_fkey" FOREIGN KEY ("source_campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
