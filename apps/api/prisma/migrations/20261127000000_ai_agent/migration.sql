-- Feature 004 AI agent (specs/004-ai-agent/data-model.md, T007). Generated with prisma migrate diff,
-- plus the generated tsvector column, its GIN index, the partial and expression unique indexes and the
-- check constraint that Prisma cannot declare.

-- CreateEnum
CREATE TYPE "AiAgentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');

-- CreateEnum
CREATE TYPE "AiKnowledgeKind" AS ENUM ('ANSWER', 'WEBSITE', 'FILE');

-- CreateEnum
CREATE TYPE "AiKnowledgeStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AiStartedBy" AS ENUM ('CUSTOMER', 'FLOW');

-- CreateEnum
CREATE TYPE "AiConversationStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "AiConversationResult" AS ENUM ('HANDED_OVER', 'MEMBER_TOOK', 'CLOSED', 'EXPIRED', 'LIMIT_REACHED', 'FAILED', 'OPTED_OUT', 'BLOCKED', 'UNPUBLISHED');

-- CreateEnum
CREATE TYPE "AiReplyKind" AS ENUM ('REPLY', 'HANDOVER', 'FALLBACK', 'LIMIT');

-- CreateEnum
CREATE TYPE "AiUsageKind" AS ENUM ('REPLY', 'PREVIEW', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AssistantRequestStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "AssistantActionKind" AS ENUM ('SEND_CAMPAIGN', 'SCHEDULE_CAMPAIGN', 'DELETE_CONTACTS', 'DELETE_TAGS');

-- CreateEnum
CREATE TYPE "AssistantActionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- AlterEnum
ALTER TYPE "ConsentSource" ADD VALUE 'AI_AGENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'AI_USAGE';
ALTER TYPE "NotificationType" ADD VALUE 'AI_FAILING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JourneyEventType" ADD VALUE 'AI_STARTED';
ALTER TYPE "JourneyEventType" ADD VALUE 'AI_ENDED';

-- AlterEnum
ALTER TYPE "JourneyActor" ADD VALUE 'AI_AGENT';

-- AlterEnum
ALTER TYPE "FlowSessionResult" ADD VALUE 'HANDED_TO_AI';

-- AlterEnum
ALTER TYPE "FlowStartedBy" ADD VALUE 'AI_AGENT';

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "ai_assistant_limit" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "ai_limit_message" TEXT,
ADD COLUMN     "ai_prices" JSONB NOT NULL DEFAULT '{"model":"claude-opus-5-5","input":4,"output":20,"cacheRead":0.2,"cacheWrite":5}',
ADD COLUMN     "ai_reply_limit" INTEGER NOT NULL DEFAULT 1000;

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "status" "AiAgentStatus" NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL DEFAULT '{}',
    "draft_revision" INTEGER NOT NULL DEFAULT 0,
    "draft_updated_at" TIMESTAMPTZ,
    "draft_updated_by_id" UUID,
    "published_version_id" UUID,
    "test_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "starter_key" VARCHAR(40),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_versions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_numbers" (
    "number_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_numbers_pkey" PRIMARY KEY ("number_id")
);

-- CreateTable
CREATE TABLE "ai_agent_secrets" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "value_encrypted" TEXT NOT NULL,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ai_agent_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_sources" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" "AiKnowledgeKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "AiKnowledgeStatus" NOT NULL DEFAULT 'PROCESSING',
    "error_code" VARCHAR(40),
    "error_message" TEXT,
    "question" TEXT,
    "answer" TEXT,
    "replace_me" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT,
    "refresh_weekly" BOOLEAN NOT NULL DEFAULT false,
    "pages_read" INTEGER,
    "storage_key" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "sha256" CHAR(64),
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "last_refreshed_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ai_knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_chunks" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "heading" TEXT,
    "url" TEXT,
    "page" INTEGER,
    "text" TEXT NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("title", '') || ' ' || coalesce("heading", '')), 'A')
        || setweight(to_tsvector('english', "text"), 'B')
        || to_tsvector('simple', "text")
    ) STORED,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "version_id" UUID,
    "contact_id" UUID,
    "number_id" UUID NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "started_by" "AiStartedBy" NOT NULL,
    "status" "AiConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "result" "AiConversationResult",
    "replies" INTEGER NOT NULL DEFAULT 0,
    "last_handled_at" TIMESTAMPTZ,
    "pending_confirmation" JSONB,
    "unanswered_streak" JSONB,
    "summary" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_replies" (
    "id" UUID NOT NULL,
    "ai_conversation_id" UUID NOT NULL,
    "chat_message_id" UUID,
    "agent_id" UUID NOT NULL,
    "version_id" UUID,
    "number_id" UUID,
    "kind" "AiReplyKind" NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "counted" BOOLEAN NOT NULL DEFAULT false,
    "language" VARCHAR(10),
    "sources" JSONB NOT NULL DEFAULT '[]',
    "skills" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(60) NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_unanswered_questions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "normalized" VARCHAR(300) NOT NULL,
    "ask_count" INTEGER NOT NULL DEFAULT 0,
    "first_asked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_asked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by_id" UUID,

    CONSTRAINT "ai_unanswered_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_unanswered_asks" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "ai_conversation_id" UUID NOT NULL,
    "asked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_unanswered_asks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_daily" (
    "id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "kind" "AiUsageKind" NOT NULL,
    "agent_id" UUID,
    "number_id" UUID,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_months" (
    "month" DATE NOT NULL,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "assistant_requests" INTEGER NOT NULL DEFAULT 0,
    "reply_alert_level" SMALLINT NOT NULL DEFAULT 0,
    "assistant_alert_level" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_months_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "assistant_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "AssistantRequestStatus" NOT NULL DEFAULT 'QUEUED',
    "reply" TEXT,
    "drafts" JSONB NOT NULL DEFAULT '[]',
    "error_code" VARCHAR(40),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "assistant_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_actions" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AssistantActionKind" NOT NULL,
    "params" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "status" "AssistantActionStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "decided_at" TIMESTAMPTZ,
    "result" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_agents_published_version_id_key" ON "ai_agents"("published_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_versions_agent_id_number_key" ON "ai_agent_versions"("agent_id", "number");

-- CreateIndex
CREATE INDEX "ai_agent_numbers_agent_id_idx" ON "ai_agent_numbers"("agent_id");

-- CreateIndex
CREATE INDEX "ai_agent_secrets_agent_id_idx" ON "ai_agent_secrets"("agent_id");

-- CreateIndex
CREATE INDEX "ai_knowledge_sources_agent_id_kind_idx" ON "ai_knowledge_sources"("agent_id", "kind");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunks_agent_id_idx" ON "ai_knowledge_chunks"("agent_id");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunks_source_id_position_idx" ON "ai_knowledge_chunks"("source_id", "position");

-- CreateIndex
CREATE INDEX "ai_conversations_conversation_id_idx" ON "ai_conversations"("conversation_id");

-- CreateIndex
CREATE INDEX "ai_conversations_status_last_activity_at_idx" ON "ai_conversations"("status", "last_activity_at");

-- CreateIndex
CREATE INDEX "ai_replies_ai_conversation_id_idx" ON "ai_replies"("ai_conversation_id");

-- CreateIndex
CREATE INDEX "ai_replies_agent_id_created_at_idx" ON "ai_replies"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_replies_created_at_idx" ON "ai_replies"("created_at");

-- CreateIndex
CREATE INDEX "ai_unanswered_questions_agent_id_resolved_at_idx" ON "ai_unanswered_questions"("agent_id", "resolved_at");

-- CreateIndex
CREATE INDEX "ai_unanswered_asks_question_id_idx" ON "ai_unanswered_asks"("question_id");

-- CreateIndex
CREATE INDEX "ai_unanswered_asks_ai_conversation_id_idx" ON "ai_unanswered_asks"("ai_conversation_id");

-- CreateIndex
CREATE INDEX "ai_usage_daily_day_idx" ON "ai_usage_daily"("day");

-- CreateIndex
CREATE INDEX "assistant_requests_user_id_created_at_idx" ON "assistant_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "assistant_actions_request_id_idx" ON "assistant_actions"("request_id");

-- CreateIndex
CREATE INDEX "assistant_actions_user_id_status_idx" ON "assistant_actions"("user_id", "status");

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_draft_updated_by_id_fkey" FOREIGN KEY ("draft_updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "ai_agent_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_numbers" ADD CONSTRAINT "ai_agent_numbers_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_numbers" ADD CONSTRAINT "ai_agent_numbers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_numbers" ADD CONSTRAINT "ai_agent_numbers_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_secrets" ADD CONSTRAINT "ai_agent_secrets_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_secrets" ADD CONSTRAINT "ai_agent_secrets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_secrets" ADD CONSTRAINT "ai_agent_secrets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "ai_agent_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_replies" ADD CONSTRAINT "ai_replies_ai_conversation_id_fkey" FOREIGN KEY ("ai_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_replies" ADD CONSTRAINT "ai_replies_chat_message_id_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_unanswered_questions" ADD CONSTRAINT "ai_unanswered_questions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_unanswered_questions" ADD CONSTRAINT "ai_unanswered_questions_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_unanswered_asks" ADD CONSTRAINT "ai_unanswered_asks_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "ai_unanswered_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_unanswered_asks" ADD CONSTRAINT "ai_unanswered_asks_ai_conversation_id_fkey" FOREIGN KEY ("ai_conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "assistant_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search over knowledge chunks (research R4).
CREATE INDEX "ai_knowledge_chunks_tsv_idx" ON "ai_knowledge_chunks" USING GIN ("tsv");

-- Agent names are unique among agents that are not deleted.
CREATE UNIQUE INDEX "ai_agents_name_active_key" ON "ai_agents" ("name") WHERE "deleted_at" IS NULL;

-- At most 3 test numbers per agent (FR-035).
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_test_numbers_max_3" CHECK (cardinality("test_numbers") <= 3);

-- One active AI conversation per chat (research R5).
CREATE UNIQUE INDEX "ai_conversations_one_active_key" ON "ai_conversations" ("conversation_id") WHERE "status" = 'ACTIVE';

-- The same file cannot be added twice to one agent.
CREATE UNIQUE INDEX "ai_knowledge_sources_agent_sha256_key" ON "ai_knowledge_sources" ("agent_id", "sha256") WHERE "sha256" IS NOT NULL;

-- Open unanswered questions are unique per agent and normalised text (FR-015).
CREATE UNIQUE INDEX "ai_unanswered_questions_open_key" ON "ai_unanswered_questions" ("agent_id", "normalized") WHERE "resolved_at" IS NULL;

-- One usage row per day, kind, agent, number and test flag (research R10).
CREATE UNIQUE INDEX "ai_usage_daily_key" ON "ai_usage_daily" (
    "day",
    "kind",
    COALESCE("agent_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("number_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "test"
);
