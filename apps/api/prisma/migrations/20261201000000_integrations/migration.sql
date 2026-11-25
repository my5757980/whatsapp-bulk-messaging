-- Feature 006: integrations and the developer platform (specs/006-integrations-platform/data-model.md, T006).
-- Generated with prisma migrate diff from the schema, plus the hand-written tail at the end.

-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FAILING');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApiCampaignStatus" AS ENUM ('DRAFT', 'LIVE', 'PAUSED', 'STOPPED');

-- CreateEnum
CREATE TYPE "TriggerOutcome" AS ENUM ('QUEUED', 'NOT_SENT');

-- CreateEnum
CREATE TYPE "StorePlatform" AS ENUM ('SHOPIFY', 'WOOCOMMERCE');

-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "StoreEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "StoreAutomationKind" AS ENUM ('ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'COD_CONFIRMATION', 'CART_REMINDER');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('COD', 'PREPAID', 'UNPAID');

-- CreateEnum
CREATE TYPE "CodStatus" AS ENUM ('NONE', 'ASKED', 'CONFIRMED', 'CANCELLED', 'NO_ANSWER', 'CLOSED');

-- CreateEnum
CREATE TYPE "StoreMessageKind" AS ENUM ('ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'COD_CONFIRMATION', 'COD_REMINDER', 'COD_REPLY');

-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('OPEN', 'REMINDING', 'RECOVERED', 'STOPPED', 'SKIPPED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ChatLinkStatus" AS ENUM ('ACTIVE', 'OFF');

-- AlterEnum
ALTER TYPE "ConsentSource" ADD VALUE 'STORE';

-- AlterEnum
ALTER TYPE "MessageOrigin" ADD VALUE 'STORE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'WEBHOOK_ENDPOINT_FAILING';
ALTER TYPE "NotificationType" ADD VALUE 'STORE_CONNECTION_ERROR';
ALTER TYPE "NotificationType" ADD VALUE 'API_CAMPAIGN_PAUSED';
ALTER TYPE "NotificationType" ADD VALUE 'COD_CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JourneyEventType" ADD VALUE 'CHAT_LINK_STARTED';
ALTER TYPE "JourneyEventType" ADD VALUE 'ORDER_PLACED';
ALTER TYPE "JourneyEventType" ADD VALUE 'COD_ANSWERED';

-- AlterEnum
ALTER TYPE "JourneyActor" ADD VALUE 'API_KEY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DripTriggerKind" ADD VALUE 'ORDER_PLACED';
ALTER TYPE "DripTriggerKind" ADD VALUE 'ORDER_DELIVERED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DripJoinVia" ADD VALUE 'ORDER_PLACED';
ALTER TYPE "DripJoinVia" ADD VALUE 'ORDER_DELIVERED';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "api_campaign_id" UUID,
ADD COLUMN     "store_cart_id" UUID,
ADD COLUMN     "store_order_id" UUID;

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY['messages.send']::TEXT[];

-- AlterTable
ALTER TABLE "tracked_link_targets" ADD COLUMN     "store_cart_id" UUID;

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "url" VARCHAR(2000) NOT NULL,
    "event_types" TEXT[],
    "include_content" BOOLEAN NOT NULL DEFAULT true,
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "secret_encrypted" TEXT NOT NULL,
    "previous_secret_encrypted" TEXT,
    "previous_secret_until" TIMESTAMPTZ,
    "last_success_at" TIMESTAMPTZ,
    "last_failure_at" TIMESTAMPTZ,
    "failing_since" TIMESTAMPTZ,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_events" (
    "id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "last_status_code" SMALLINT,
    "last_error" VARCHAR(60),
    "last_duration_ms" INTEGER,
    "delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_campaigns" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "api_name" VARCHAR(60) NOT NULL,
    "number_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "variable_mapping" JSONB NOT NULL DEFAULT '{}',
    "header_media_asset_id" UUID,
    "tags" TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "create_contacts" BOOLEAN NOT NULL DEFAULT true,
    "daily_limit" INTEGER,
    "status" "ApiCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "paused_reason" VARCHAR(40),
    "went_live_at" TIMESTAMPTZ,
    "paused_at" TIMESTAMPTZ,
    "stopped_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "api_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_campaign_triggers" (
    "id" UUID NOT NULL,
    "api_campaign_id" UUID NOT NULL,
    "api_key_id" UUID,
    "contact_id" UUID,
    "phone_e164" VARCHAR(16),
    "outcome" "TriggerOutcome" NOT NULL,
    "reason" VARCHAR(40),
    "message_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_campaign_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_connections" (
    "id" UUID NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "base_url" VARCHAR(255) NOT NULL,
    "credentials_encrypted" TEXT NOT NULL,
    "webhook_secret_encrypted" TEXT,
    "access_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMPTZ,
    "number_id" UUID NOT NULL,
    "default_country" CHAR(2) NOT NULL,
    "customer_tag" VARCHAR(50) NOT NULL,
    "consent_is_whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "consent_confirmed_by_id" UUID,
    "consent_confirmed_at" TIMESTAMPTZ,
    "shipped_status" VARCHAR(40),
    "delivered_status" VARCHAR(40),
    "status" "StoreStatus" NOT NULL DEFAULT 'CONNECTED',
    "last_error" VARCHAR(200),
    "last_event_at" TIMESTAMPTZ,
    "last_synced_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_events" (
    "id" BIGSERIAL NOT NULL,
    "store_id" UUID NOT NULL,
    "external_id" VARCHAR(100) NOT NULL,
    "topic" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "StoreEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" VARCHAR(200),
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "store_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_automations" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "kind" "StoreAutomationKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_orders" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "order_number" VARCHAR(40) NOT NULL,
    "contact_id" UUID,
    "phone_e164" VARCHAR(16),
    "phone_source" VARCHAR(10),
    "customer_name" VARCHAR(120),
    "total" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payment_kind" "PaymentKind" NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "placed_at" TIMESTAMPTZ NOT NULL,
    "store_updated_at" TIMESTAMPTZ NOT NULL,
    "cod_status" "CodStatus" NOT NULL DEFAULT 'NONE',
    "cod_asked_at" TIMESTAMPTZ,
    "cod_answered_at" TIMESTAMPTZ,
    "cod_next_at" TIMESTAMPTZ,
    "cod_reminded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_order_messages" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" "StoreMessageKind" NOT NULL,
    "outcome" "StepOutcome" NOT NULL,
    "skip_reason" VARCHAR(40),
    "message_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_order_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_carts" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "contact_id" UUID,
    "phone_e164" VARCHAR(16),
    "value" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "items_summary" VARCHAR(300),
    "cart_url" VARCHAR(2000),
    "started_at" TIMESTAMPTZ NOT NULL,
    "store_updated_at" TIMESTAMPTZ NOT NULL,
    "status" "CartStatus" NOT NULL DEFAULT 'OPEN',
    "stop_reason" VARCHAR(40),
    "next_step" SMALLINT NOT NULL DEFAULT 1,
    "next_at" TIMESTAMPTZ,
    "last_reminder_at" TIMESTAMPTZ,
    "recovered_order_id" UUID,
    "recovered_value" DECIMAL(14,2),
    "recovered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "store_carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_cart_reminders" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "step" SMALLINT NOT NULL,
    "outcome" "StepOutcome" NOT NULL,
    "skip_reason" VARCHAR(40),
    "message_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_cart_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_links" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "number_id" UUID NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "ref" CHAR(6) NOT NULL,
    "code" CHAR(10) NOT NULL,
    "flow_id" UUID,
    "tag_id" UUID,
    "status" "ChatLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_link_opens" (
    "id" UUID NOT NULL,
    "chat_link_id" UUID NOT NULL,
    "device" "ClickDevice" NOT NULL,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_link_opens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_link_starts" (
    "id" UUID NOT NULL,
    "chat_link_id" UUID NOT NULL,
    "contact_id" UUID,
    "conversation_id" UUID,
    "new_contact" BOOLEAN NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_link_starts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_connection_checks" (
    "id" UUID NOT NULL,
    "number_id" UUID,
    "waba_id" VARCHAR(40),
    "phone_number_id" VARCHAR(40),
    "results" JSONB NOT NULL DEFAULT '[]',
    "run_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "number_connection_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_idempotent_responses" (
    "id" UUID NOT NULL,
    "api_key_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" SMALLINT NOT NULL,
    "body" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_idempotent_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_name_key" ON "webhook_endpoints"("name");

-- CreateIndex
CREATE INDEX "outbound_events_created_at_idx" ON "outbound_events"("created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_event_id_key" ON "webhook_deliveries"("endpoint_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_campaigns_api_name_key" ON "api_campaigns"("api_name");

-- CreateIndex
CREATE INDEX "api_campaigns_status_idx" ON "api_campaigns"("status");

-- CreateIndex
CREATE INDEX "api_campaigns_template_id_idx" ON "api_campaigns"("template_id");

-- CreateIndex
CREATE INDEX "api_campaigns_number_id_idx" ON "api_campaigns"("number_id");

-- CreateIndex
CREATE INDEX "api_campaign_triggers_api_campaign_id_created_at_idx" ON "api_campaign_triggers"("api_campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "api_campaign_triggers_contact_id_idx" ON "api_campaign_triggers"("contact_id");

-- CreateIndex
CREATE INDEX "api_campaign_triggers_message_id_idx" ON "api_campaign_triggers"("message_id");

-- CreateIndex
CREATE INDEX "api_campaign_triggers_created_at_idx" ON "api_campaign_triggers"("created_at");

-- CreateIndex
CREATE INDEX "store_connections_status_idx" ON "store_connections"("status");

-- CreateIndex
CREATE INDEX "store_connections_number_id_idx" ON "store_connections"("number_id");

-- CreateIndex
CREATE INDEX "store_events_received_at_idx" ON "store_events"("received_at");

-- CreateIndex
CREATE INDEX "store_events_status_received_at_idx" ON "store_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_events_store_id_external_id_key" ON "store_events"("store_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_automations_store_id_kind_key" ON "store_automations"("store_id", "kind");

-- CreateIndex
CREATE INDEX "store_orders_cod_status_cod_next_at_idx" ON "store_orders"("cod_status", "cod_next_at");

-- CreateIndex
CREATE INDEX "store_orders_contact_id_idx" ON "store_orders"("contact_id");

-- CreateIndex
CREATE INDEX "store_orders_store_id_placed_at_idx" ON "store_orders"("store_id", "placed_at");

-- CreateIndex
CREATE INDEX "store_orders_created_at_idx" ON "store_orders"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_orders_store_id_external_id_key" ON "store_orders"("store_id", "external_id");

-- CreateIndex
CREATE INDEX "store_order_messages_order_id_idx" ON "store_order_messages"("order_id");

-- CreateIndex
CREATE INDEX "store_order_messages_message_id_idx" ON "store_order_messages"("message_id");

-- CreateIndex
CREATE INDEX "store_carts_status_next_at_idx" ON "store_carts"("status", "next_at");

-- CreateIndex
CREATE INDEX "store_carts_contact_id_idx" ON "store_carts"("contact_id");

-- CreateIndex
CREATE INDEX "store_carts_recovered_order_id_idx" ON "store_carts"("recovered_order_id");

-- CreateIndex
CREATE INDEX "store_carts_created_at_idx" ON "store_carts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_carts_store_id_external_id_key" ON "store_carts"("store_id", "external_id");

-- CreateIndex
CREATE INDEX "store_cart_reminders_message_id_idx" ON "store_cart_reminders"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_cart_reminders_cart_id_step_key" ON "store_cart_reminders"("cart_id", "step");

-- CreateIndex
CREATE UNIQUE INDEX "chat_links_ref_key" ON "chat_links"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "chat_links_code_key" ON "chat_links"("code");

-- CreateIndex
CREATE INDEX "chat_links_number_id_idx" ON "chat_links"("number_id");

-- CreateIndex
CREATE INDEX "chat_links_flow_id_idx" ON "chat_links"("flow_id");

-- CreateIndex
CREATE INDEX "chat_links_tag_id_idx" ON "chat_links"("tag_id");

-- CreateIndex
CREATE INDEX "chat_link_opens_chat_link_id_opened_at_idx" ON "chat_link_opens"("chat_link_id", "opened_at");

-- CreateIndex
CREATE INDEX "chat_link_opens_opened_at_idx" ON "chat_link_opens"("opened_at");

-- CreateIndex
CREATE INDEX "chat_link_starts_chat_link_id_started_at_idx" ON "chat_link_starts"("chat_link_id", "started_at");

-- CreateIndex
CREATE INDEX "chat_link_starts_contact_id_idx" ON "chat_link_starts"("contact_id");

-- CreateIndex
CREATE INDEX "chat_link_starts_conversation_id_idx" ON "chat_link_starts"("conversation_id");

-- CreateIndex
CREATE INDEX "chat_link_starts_started_at_idx" ON "chat_link_starts"("started_at");

-- CreateIndex
CREATE INDEX "number_connection_checks_number_id_idx" ON "number_connection_checks"("number_id");

-- CreateIndex
CREATE INDEX "number_connection_checks_created_at_idx" ON "number_connection_checks"("created_at");

-- CreateIndex
CREATE INDEX "api_idempotent_responses_expires_at_idx" ON "api_idempotent_responses"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_idempotent_responses_api_key_id_key_key" ON "api_idempotent_responses"("api_key_id", "key");

-- CreateIndex
CREATE INDEX "messages_api_campaign_id_idx" ON "messages"("api_campaign_id");

-- CreateIndex
CREATE INDEX "messages_store_order_id_idx" ON "messages"("store_order_id");

-- CreateIndex
CREATE INDEX "messages_store_cart_id_idx" ON "messages"("store_cart_id");

-- CreateIndex
CREATE INDEX "tracked_link_targets_store_cart_id_idx" ON "tracked_link_targets"("store_cart_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_api_campaign_id_fkey" FOREIGN KEY ("api_campaign_id") REFERENCES "api_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_store_order_id_fkey" FOREIGN KEY ("store_order_id") REFERENCES "store_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_store_cart_id_fkey" FOREIGN KEY ("store_cart_id") REFERENCES "store_carts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_link_targets" ADD CONSTRAINT "tracked_link_targets_store_cart_id_fkey" FOREIGN KEY ("store_cart_id") REFERENCES "store_carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbound_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaigns" ADD CONSTRAINT "api_campaigns_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaigns" ADD CONSTRAINT "api_campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaigns" ADD CONSTRAINT "api_campaigns_header_media_asset_id_fkey" FOREIGN KEY ("header_media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaigns" ADD CONSTRAINT "api_campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaign_triggers" ADD CONSTRAINT "api_campaign_triggers_api_campaign_id_fkey" FOREIGN KEY ("api_campaign_id") REFERENCES "api_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaign_triggers" ADD CONSTRAINT "api_campaign_triggers_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaign_triggers" ADD CONSTRAINT "api_campaign_triggers_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_campaign_triggers" ADD CONSTRAINT "api_campaign_triggers_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_consent_confirmed_by_id_fkey" FOREIGN KEY ("consent_confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_events" ADD CONSTRAINT "store_events_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_automations" ADD CONSTRAINT "store_automations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_automations" ADD CONSTRAINT "store_automations_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_order_messages" ADD CONSTRAINT "store_order_messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "store_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_order_messages" ADD CONSTRAINT "store_order_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_carts" ADD CONSTRAINT "store_carts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_carts" ADD CONSTRAINT "store_carts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_carts" ADD CONSTRAINT "store_carts_recovered_order_id_fkey" FOREIGN KEY ("recovered_order_id") REFERENCES "store_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_cart_reminders" ADD CONSTRAINT "store_cart_reminders_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "store_carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_cart_reminders" ADD CONSTRAINT "store_cart_reminders_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_link_opens" ADD CONSTRAINT "chat_link_opens_chat_link_id_fkey" FOREIGN KEY ("chat_link_id") REFERENCES "chat_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_link_starts" ADD CONSTRAINT "chat_link_starts_chat_link_id_fkey" FOREIGN KEY ("chat_link_id") REFERENCES "chat_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_link_starts" ADD CONSTRAINT "chat_link_starts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_link_starts" ADD CONSTRAINT "chat_link_starts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_connection_checks" ADD CONSTRAINT "number_connection_checks_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_connection_checks" ADD CONSTRAINT "number_connection_checks_run_by_id_fkey" FOREIGN KEY ("run_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_idempotent_responses" ADD CONSTRAINT "api_idempotent_responses_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Hand-written (data-model.md §1 and §4) ----------

-- Each notification or COD message at most once per order; the COD reply may repeat (FR-030, FR-036).
CREATE UNIQUE INDEX "store_order_messages_order_kind_once_key" ON "store_order_messages"("order_id", "kind") WHERE "kind" <> 'COD_REPLY';

-- A contact counts once a day per chat link (FR-049).
CREATE UNIQUE INDEX "chat_link_starts_daily_key" ON "chat_link_starts"("chat_link_id", "contact_id", (("started_at" AT TIME ZONE 'UTC')::date));

-- Names are unique among live records only.
CREATE UNIQUE INDEX "api_campaigns_name_live_key" ON "api_campaigns"("name") WHERE "status" <> 'STOPPED';
CREATE UNIQUE INDEX "chat_links_name_live_key" ON "chat_links"("name") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "store_connections_base_url_live_key" ON "store_connections"("platform", "base_url") WHERE "status" <> 'DISCONNECTED';

-- Checks.
ALTER TABLE "api_campaigns" ADD CONSTRAINT "api_campaigns_api_name_check" CHECK ("api_name" ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$');
ALTER TABLE "api_campaigns" ADD CONSTRAINT "api_campaigns_daily_limit_check" CHECK ("daily_limit" IS NULL OR "daily_limit" BETWEEN 1 AND 100000);
ALTER TABLE "store_cart_reminders" ADD CONSTRAINT "store_cart_reminders_step_check" CHECK ("step" BETWEEN 1 AND 3);
ALTER TABLE "store_carts" ADD CONSTRAINT "store_carts_next_step_check" CHECK ("next_step" BETWEEN 1 AND 4);
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_base_url_check" CHECK ("base_url" ~ '^https?://');
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_event_types_check" CHECK (cardinality("event_types") >= 1);
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_ref_check" CHECK ("ref" ~ '^[A-Z0-9]{6}$');
-- Tracked links of cart reminders (US6): a target belongs to a campaign, a drip step or a store cart.
ALTER TABLE "tracked_link_targets" DROP CONSTRAINT "tracked_link_targets_one_owner";
ALTER TABLE "tracked_link_targets" ADD CONSTRAINT "tracked_link_targets_one_owner" CHECK (num_nonnulls("campaign_id", "drip_step_id", "store_cart_id") = 1);
