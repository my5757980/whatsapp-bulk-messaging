-- Feature 003 chatbot flows (specs/003-chatbot-flow-builder/data-model.md, T005). Generated with
-- prisma migrate diff, plus the partial unique indexes and the check constraint Prisma cannot declare.

-- CreateEnum
CREATE TYPE "FlowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');

-- CreateEnum
CREATE TYPE "FlowVersionKind" AS ENUM ('PUBLISHED', 'REVISION');

-- CreateEnum
CREATE TYPE "FlowTriggerKind" AS ENUM ('KEYWORD', 'PATTERN', 'TEMPLATE_BUTTON', 'FIRST_MESSAGE');

-- CreateEnum
CREATE TYPE "KeywordMatch" AS ENUM ('EXACT', 'CONTAINS');

-- CreateEnum
CREATE TYPE "FlowSessionStatus" AS ENUM ('RUNNING', 'ENDED');

-- CreateEnum
CREATE TYPE "FlowSessionResult" AS ENUM ('COMPLETED', 'HANDED_OVER', 'TIMED_OUT', 'STOPPED_BY_MEMBER', 'OPTED_OUT', 'INTERRUPTED', 'WINDOW_CLOSED', 'SEND_FAILED', 'FLOW_UNPUBLISHED', 'EXPIRED', 'BLOCKED', 'FAILED');

-- CreateEnum
CREATE TYPE "FlowWait" AS ENUM ('NONE', 'INPUT', 'DELAY', 'API');

-- CreateEnum
CREATE TYPE "FlowStartedBy" AS ENUM ('TRIGGER', 'MEMBER', 'JUMP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ChatContentType" ADD VALUE 'BUTTONS';
ALTER TYPE "ChatContentType" ADD VALUE 'LIST';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JourneyEventType" ADD VALUE 'FLOW_STARTED';
ALTER TYPE "JourneyEventType" ADD VALUE 'FLOW_ENDED';

-- AlterEnum
ALTER TYPE "JourneyActor" ADD VALUE 'FLOW';

-- CreateTable
CREATE TABLE "flows" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "status" "FlowStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "all_numbers" BOOLEAN NOT NULL DEFAULT true,
    "published_version_id" UUID,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "draft_revision" INTEGER NOT NULL DEFAULT 0,
    "draft_updated_at" TIMESTAMPTZ,
    "draft_updated_by_id" UUID,
    "test_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "starter_key" VARCHAR(40),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_numbers" (
    "flow_id" UUID NOT NULL,
    "number_id" UUID NOT NULL,

    CONSTRAINT "flow_numbers_pkey" PRIMARY KEY ("flow_id","number_id")
);

-- CreateTable
CREATE TABLE "flow_versions" (
    "id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "kind" "FlowVersionKind" NOT NULL,
    "number" INTEGER,
    "graph" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_triggers" (
    "id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "flow_version_id" UUID NOT NULL,
    "trigger_key" VARCHAR(40) NOT NULL,
    "kind" "FlowTriggerKind" NOT NULL,
    "match" "KeywordMatch",
    "phrase" VARCHAR(200),
    "pattern" VARCHAR(200),
    "template_id" UUID,
    "button_text" VARCHAR(25),
    "first_message_tag_id" UUID,
    "start_flow" BOOLEAN NOT NULL DEFAULT true,
    "answer_name" VARCHAR(40),
    "can_interrupt" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "flow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_sessions" (
    "id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "flow_version_id" UUID,
    "conversation_id" UUID NOT NULL,
    "contact_id" UUID,
    "number_id" UUID NOT NULL,
    "status" "FlowSessionStatus" NOT NULL DEFAULT 'RUNNING',
    "result" "FlowSessionResult",
    "failure_reason" VARCHAR(120),
    "current_step_id" VARCHAR(40),
    "wait" "FlowWait" NOT NULL DEFAULT 'NONE',
    "wait_token" INTEGER NOT NULL DEFAULT 0,
    "wait_until" TIMESTAMPTZ,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "steps_since_input" INTEGER NOT NULL DEFAULT 0,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "started_by" "FlowStartedBy" NOT NULL,
    "started_by_user_id" UUID,
    "trigger_key" VARCHAR(40),
    "parent_session_id" UUID,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "flow_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_session_steps" (
    "id" BIGSERIAL NOT NULL,
    "session_id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "flow_version_id" UUID,
    "step_id" VARCHAR(40) NOT NULL,
    "entered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,
    "branch" VARCHAR(60),

    CONSTRAINT "flow_session_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_secrets" (
    "id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "value_encrypted" TEXT NOT NULL,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "flow_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "flows_published_version_id_key" ON "flows"("published_version_id");

-- CreateIndex
CREATE INDEX "flow_numbers_number_id_idx" ON "flow_numbers"("number_id");

-- CreateIndex
CREATE INDEX "flow_versions_flow_id_kind_created_at_idx" ON "flow_versions"("flow_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "flow_versions_flow_id_number_key" ON "flow_versions"("flow_id", "number");

-- CreateIndex
CREATE INDEX "flow_triggers_kind_phrase_idx" ON "flow_triggers"("kind", "phrase");

-- CreateIndex
CREATE INDEX "flow_triggers_template_id_button_text_idx" ON "flow_triggers"("template_id", "button_text");

-- CreateIndex
CREATE INDEX "flow_triggers_flow_id_idx" ON "flow_triggers"("flow_id");

-- CreateIndex
CREATE INDEX "flow_sessions_status_last_activity_at_idx" ON "flow_sessions"("status", "last_activity_at");

-- CreateIndex
CREATE INDEX "flow_sessions_flow_id_started_at_idx" ON "flow_sessions"("flow_id", "started_at");

-- CreateIndex
CREATE INDEX "flow_sessions_conversation_id_started_at_idx" ON "flow_sessions"("conversation_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "flow_session_steps_flow_id_flow_version_id_step_id_entered__idx" ON "flow_session_steps"("flow_id", "flow_version_id", "step_id", "entered_at");

-- CreateIndex
CREATE INDEX "flow_session_steps_session_id_idx" ON "flow_session_steps"("session_id");

-- CreateIndex
CREATE INDEX "flow_secrets_flow_id_idx" ON "flow_secrets"("flow_id");

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_draft_updated_by_id_fkey" FOREIGN KEY ("draft_updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_numbers" ADD CONSTRAINT "flow_numbers_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_numbers" ADD CONSTRAINT "flow_numbers_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_triggers" ADD CONSTRAINT "flow_triggers_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_triggers" ADD CONSTRAINT "flow_triggers_flow_version_id_fkey" FOREIGN KEY ("flow_version_id") REFERENCES "flow_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_triggers" ADD CONSTRAINT "flow_triggers_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_triggers" ADD CONSTRAINT "flow_triggers_first_message_tag_id_fkey" FOREIGN KEY ("first_message_tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_flow_version_id_fkey" FOREIGN KEY ("flow_version_id") REFERENCES "flow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_sessions" ADD CONSTRAINT "flow_sessions_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_session_steps" ADD CONSTRAINT "flow_session_steps_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "flow_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_secrets" ADD CONSTRAINT "flow_secrets_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_secrets" ADD CONSTRAINT "flow_secrets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flow_secrets" ADD CONSTRAINT "flow_secrets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One running session per conversation (contact + number), FR-024.
CREATE UNIQUE INDEX "flow_sessions_one_running_per_conversation" ON "flow_sessions"("conversation_id") WHERE "status" = 'RUNNING';

-- Flow names are unique among flows that are not deleted (citext: ignoring case).
CREATE UNIQUE INDEX "flows_name_active_key" ON "flows"("name") WHERE "deleted_at" IS NULL;

-- At most 3 test numbers per flow (FR-034).
ALTER TABLE "flows" ADD CONSTRAINT "flows_test_numbers_max_3" CHECK (cardinality("test_numbers") <= 3);
