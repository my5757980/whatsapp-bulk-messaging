-- CreateEnum
CREATE TYPE "LeadSourceKind" AS ENUM ('UNKNOWN', 'ORGANIC', 'API', 'IMPORT', 'CAMPAIGN_UPLOAD', 'CHAT_LINK', 'AD', 'LEAD_FORM', 'FORM', 'WEBSITE_BUTTON', 'STORE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BulkActionKind" AS ENUM ('TAG_ADD', 'TAG_REMOVE', 'DRIP_ENROL');

-- CreateEnum
CREATE TYPE "BulkActionStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "AutoTagEvent" AS ENUM ('CONTACT_CREATED', 'CAMPAIGN_REPLY', 'LINK_CLICK', 'OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "DateAutomationTiming" AS ENUM ('YEARLY', 'ONCE');

-- CreateEnum
CREATE TYPE "DateAutomationStatus" AS ENUM ('OFF', 'ON', 'PAUSED');

-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- AlterEnum
ALTER TYPE "AudienceType" ADD VALUE 'SEGMENT';

-- AlterEnum
ALTER TYPE "MessageOrigin" ADD VALUE 'DATE_AUTOMATION';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'DATE_AUTOMATION_PAUSED';

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "opt_in_reply" JSONB NOT NULL DEFAULT '{"kind":"NONE"}',
ADD COLUMN     "opt_out_reply" JSONB NOT NULL DEFAULT '{"kind":"NONE"}',
ADD COLUMN     "require_2fa" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "lead_source_kind" "LeadSourceKind" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "segment_id" UUID;

-- CreateTable
CREATE TABLE "segments" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "rules" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_actions" (
    "id" UUID NOT NULL,
    "kind" "BulkActionKind" NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "selection" JSONB NOT NULL,
    "status" "BulkActionStatus" NOT NULL DEFAULT 'QUEUED',
    "total" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" VARCHAR(300),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "bulk_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_tag_rules" (
    "id" UUID NOT NULL,
    "event" "AutoTagEvent" NOT NULL,
    "lead_source_kind" "LeadSourceKind",
    "tag_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_tag_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_attributes" (
    "id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "description" VARCHAR(200),
    "value" VARCHAR(1024) NOT NULL DEFAULT '',
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "global_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "date_automations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "attribute_key" VARCHAR(40) NOT NULL,
    "timing" "DateAutomationTiming" NOT NULL,
    "offset_days" SMALLINT NOT NULL DEFAULT 0,
    "send_time" CHAR(5) NOT NULL,
    "number_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "variable_mapping" JSONB NOT NULL DEFAULT '{}',
    "status" "DateAutomationStatus" NOT NULL DEFAULT 'OFF',
    "paused_reason" VARCHAR(120),
    "last_run_date" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "date_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "date_automation_occurrences" (
    "id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(40),
    "message_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "date_automation_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_two_factor" (
    "user_id" UUID NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "enabled_at" TIMESTAMPTZ,
    "last_step" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_two_factor_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_business_profiles" (
    "number_id" UUID NOT NULL,
    "about" TEXT,
    "address" TEXT,
    "description" TEXT,
    "email" TEXT,
    "vertical" TEXT,
    "websites" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "profile_picture_url" TEXT,
    "verified_name" VARCHAR(200),
    "name_status" VARCHAR(20),
    "new_name_status" VARCHAR(20),
    "read_at" TIMESTAMPTZ NOT NULL,
    "changed_at" TIMESTAMPTZ,
    "changed_by_id" UUID,

    CONSTRAINT "number_business_profiles_pkey" PRIMARY KEY ("number_id")
);

-- CreateTable
CREATE TABLE "oba_checklist" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "steps" JSONB NOT NULL DEFAULT '{}',
    "applied_at" DATE,
    "result" VARCHAR(20),
    "note" VARCHAR(500),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "oba_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "segments_name_key" ON "segments"("name");

-- CreateIndex
CREATE INDEX "bulk_actions_created_at_idx" ON "bulk_actions"("created_at");

-- CreateIndex
-- NULLS NOT DISTINCT: a rule without a lead source cannot be added twice (Postgres 15+).
CREATE UNIQUE INDEX "auto_tag_rules_event_lead_source_kind_tag_id_key" ON "auto_tag_rules"("event", "lead_source_kind", "tag_id") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "global_attributes_key_key" ON "global_attributes"("key");

-- CreateIndex
CREATE UNIQUE INDEX "date_automations_name_key" ON "date_automations"("name");

-- CreateIndex
CREATE INDEX "date_automations_status_idx" ON "date_automations"("status");

-- CreateIndex
CREATE INDEX "date_automation_occurrences_automation_id_due_date_status_idx" ON "date_automation_occurrences"("automation_id", "due_date", "status");

-- CreateIndex
CREATE INDEX "date_automation_occurrences_message_id_idx" ON "date_automation_occurrences"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "date_automation_occurrences_automation_id_contact_id_due_da_key" ON "date_automation_occurrences"("automation_id", "contact_id", "due_date");

-- CreateIndex
CREATE INDEX "user_recovery_codes_user_id_idx" ON "user_recovery_codes"("user_id");

-- CreateIndex
CREATE INDEX "contacts_lead_source_kind_idx" ON "contacts"("lead_source_kind");

-- CreateIndex
CREATE INDEX "messages_contact_id_created_at_idx" ON "messages"("contact_id", "created_at");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_actions" ADD CONSTRAINT "bulk_actions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_tag_rules" ADD CONSTRAINT "auto_tag_rules_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_tag_rules" ADD CONSTRAINT "auto_tag_rules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_attributes" ADD CONSTRAINT "global_attributes_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "date_automations" ADD CONSTRAINT "date_automations_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "date_automations" ADD CONSTRAINT "date_automations_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "date_automations" ADD CONSTRAINT "date_automations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "date_automation_occurrences" ADD CONSTRAINT "date_automation_occurrences_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "date_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "date_automation_occurrences" ADD CONSTRAINT "date_automation_occurrences_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "date_automation_occurrences" ADD CONSTRAINT "date_automation_occurrences_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_two_factor" ADD CONSTRAINT "user_two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_business_profiles" ADD CONSTRAINT "number_business_profiles_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_business_profiles" ADD CONSTRAINT "number_business_profiles_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oba_checklist" ADD CONSTRAINT "oba_checklist_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- Hand-written (feature 010) ----------

-- Lead source kinds from the existing free text (research R5); other text becomes CUSTOM with the text
-- kept as its label, and empty values stay UNKNOWN.
UPDATE "contacts" SET "lead_source_kind" = CASE lower(btrim("lead_source"))
    WHEN 'organic' THEN 'ORGANIC'::"LeadSourceKind"
    WHEN 'api' THEN 'API'::"LeadSourceKind"
    WHEN 'import' THEN 'IMPORT'::"LeadSourceKind"
    WHEN 'campaign upload' THEN 'CAMPAIGN_UPLOAD'::"LeadSourceKind"
    WHEN 'store' THEN 'STORE'::"LeadSourceKind"
    WHEN 'lead form' THEN 'LEAD_FORM'::"LeadSourceKind"
    ELSE 'CUSTOM'::"LeadSourceKind"
  END
  WHERE "lead_source" IS NOT NULL AND btrim("lead_source") <> '';
-- Kinds that carry no extra label lose the old text, so labels only hold real labels.
UPDATE "contacts" SET "lead_source" = NULL
  WHERE "lead_source_kind" IN ('ORGANIC', 'API', 'CAMPAIGN_UPLOAD', 'STORE', 'LEAD_FORM')
     OR ("lead_source_kind" = 'IMPORT' AND lower(btrim("lead_source")) = 'import');

-- A SEGMENT audience needs its segment and nothing else does. The text cast avoids using the enum value
-- added above inside the same transaction.
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segment_check"
  CHECK (("audience_type"::text = 'SEGMENT') = ("segment_id" IS NOT NULL));

-- CONTACT_CREATED rules name a lead source; other rules do not.
ALTER TABLE "auto_tag_rules" ADD CONSTRAINT "auto_tag_rules_lead_source_check"
  CHECK (("event" = 'CONTACT_CREATED') = ("lead_source_kind" IS NOT NULL));

-- Date automations: an offset of at most 30 days either side, and a send time HH:mm.
ALTER TABLE "date_automations" ADD CONSTRAINT "date_automations_offset_check" CHECK ("offset_days" BETWEEN -30 AND 30);
ALTER TABLE "date_automations" ADD CONSTRAINT "date_automations_send_time_check" CHECK ("send_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- The blue tick checklist is a single row.
ALTER TABLE "oba_checklist" ADD CONSTRAINT "oba_checklist_single_row" CHECK ("id" = 1);
