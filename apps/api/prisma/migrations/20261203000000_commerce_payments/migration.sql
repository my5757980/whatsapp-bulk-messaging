-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE');

-- CreateEnum
CREATE TYPE "GatewayMode" AS ENUM ('LIVE', 'TEST');

-- CreateEnum
CREATE TYPE "GatewayStatus" AS ENUM ('CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('WAITING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('INBOX', 'FLOW', 'CAMPAIGN', 'API', 'STORE_ORDER', 'CHAT_ORDER');

-- CreateEnum
CREATE TYPE "PaymentEventSource" AS ENUM ('WEBHOOK', 'RECONCILE', 'CHECK');

-- CreateEnum
CREATE TYPE "PaymentEventResult" AS ENUM ('PENDING', 'APPLIED', 'IGNORED', 'DUPLICATE', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChatOrderMode" AS ENUM ('AUTO', 'REVIEW', 'FLOW');

-- CreateEnum
CREATE TYPE "ChatOrderStatus" AS ENUM ('RECEIVED', 'LINK_SENT', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FormVersionStatus" AS ENUM ('PUBLISHED', 'FAILED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "FormCategory" AS ENUM ('SIGN_UP', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION', 'CONTACT_US', 'CUSTOMER_SUPPORT', 'SURVEY', 'OTHER');

-- AlterEnum
ALTER TYPE "ConsentSource" ADD VALUE 'FORM';

-- AlterEnum
ALTER TYPE "MessageOrigin" ADD VALUE 'PAYMENTS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_PAID_LATE';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENTS_CONNECTION_ERROR';
ALTER TYPE "NotificationType" ADD VALUE 'CATALOG_SYNC_FAILED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ChatContentType" ADD VALUE 'PAYMENT_REQUEST';
ALTER TYPE "ChatContentType" ADD VALUE 'PRODUCT';
ALTER TYPE "ChatContentType" ADD VALUE 'PRODUCT_LIST';
ALTER TYPE "ChatContentType" ADD VALUE 'CATALOG';
ALTER TYPE "ChatContentType" ADD VALUE 'ORDER';
ALTER TYPE "ChatContentType" ADD VALUE 'FORM';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JourneyEventType" ADD VALUE 'PAYMENT_REQUESTED';
ALTER TYPE "JourneyEventType" ADD VALUE 'PAYMENT_PAID';
ALTER TYPE "JourneyEventType" ADD VALUE 'PAYMENT_EXPIRED';
ALTER TYPE "JourneyEventType" ADD VALUE 'PAYMENT_REFUNDED';
ALTER TYPE "JourneyEventType" ADD VALUE 'CHAT_ORDER_RECEIVED';
ALTER TYPE "JourneyEventType" ADD VALUE 'FORM_SUBMITTED';

-- AlterEnum
ALTER TYPE "StoreAutomationKind" ADD VALUE 'PAY_LINK';

-- AlterEnum (feature 008: payment campaign recipients without an amount are held back)
ALTER TYPE "SkipReason" ADD VALUE 'PAYMENT_AMOUNT_MISSING';

-- AlterEnum (feature 008: a store order's Pay now link is sent once)
ALTER TYPE "StoreMessageKind" ADD VALUE 'PAY_LINK';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "payment_config" JSONB;

-- AlterTable
ALTER TABLE "store_orders" ADD COLUMN     "paid_via_link_at" TIMESTAMPTZ,
ADD COLUMN     "payment_request_id" UUID;

-- CreateTable
CREATE TABLE "payment_gateways" (
    "id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
    "mode" "GatewayMode" NOT NULL,
    "account_id" VARCHAR(64),
    "account_name" VARCHAR(200),
    "country" CHAR(2),
    "currency" CHAR(3) NOT NULL,
    "secret_key_enc" TEXT NOT NULL,
    "key_kind" VARCHAR(10) NOT NULL,
    "webhook_secret_enc" TEXT,
    "previous_webhook_secret_enc" TEXT,
    "previous_secret_until" TIMESTAMPTZ,
    "webhook_endpoint_id" VARCHAR(64),
    "status" "GatewayStatus" NOT NULL DEFAULT 'CONNECTED',
    "checks" JSONB NOT NULL DEFAULT '[]',
    "notification_check" JSONB NOT NULL DEFAULT '{"status":"NOT_RUN"}',
    "last_checked_at" TIMESTAMPTZ,
    "last_event_at" TIMESTAMPTZ,
    "events_cursor" TIMESTAMPTZ,
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_settings" (
    "id" UUID NOT NULL,
    "max_amount_minor" BIGINT NOT NULL DEFAULT 1000000,
    "default_expiry_minutes" INTEGER NOT NULL DEFAULT 1440,
    "request_roles" TEXT[] DEFAULT ARRAY['ADMIN', 'MANAGER', 'AGENT']::TEXT[],
    "session_text" VARCHAR(1024) NOT NULL DEFAULT '{description}
Amount: {amount}
Please pay by {expires}.',
    "button_text" VARCHAR(20) NOT NULL DEFAULT 'Pay now',
    "template_id" UUID,
    "template_mapping" JSONB NOT NULL DEFAULT '{}',
    "reminders" JSONB NOT NULL DEFAULT '[]',
    "chat_order_mode" "ChatOrderMode" NOT NULL DEFAULT 'REVIEW',
    "chat_order_expiry_minutes" INTEGER NOT NULL DEFAULT 1440,
    "chat_order_tag_id" UUID,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "contact_id" UUID,
    "conversation_id" UUID,
    "phone_e164" VARCHAR(16),
    "customer_name" VARCHAR(120),
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "description" VARCHAR(250) NOT NULL,
    "reference" VARCHAR(80),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'WAITING',
    "source" "PaymentSource" NOT NULL,
    "created_by_id" UUID,
    "api_key_id" UUID,
    "flow_session_id" UUID,
    "campaign_id" UUID,
    "message_id" UUID,
    "chat_item_id" UUID,
    "store_order_id" UUID,
    "chat_order_id" UUID,
    "tag_id" UUID,
    "flow_id" UUID,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "session_id" VARCHAR(80),
    "session_url" TEXT,
    "session_expires_at" TIMESTAMPTZ,
    "sessions_created" INTEGER NOT NULL DEFAULT 0,
    "session_expire_pending" BOOLEAN NOT NULL DEFAULT false,
    "session_expire_attempts" INTEGER NOT NULL DEFAULT 0,
    "payment_intent_id" VARCHAR(80),
    "paid_at" TIMESTAMPTZ,
    "paid_amount_minor" BIGINT,
    "paid_late" BOOLEAN NOT NULL DEFAULT false,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_failure_code" VARCHAR(60),
    "last_failed_at" TIMESTAMPTZ,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "refunded_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by_id" UUID,
    "expired_at" TIMESTAMPTZ,
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "next_reminder_at" TIMESTAMPTZ,
    "opens" INTEGER NOT NULL DEFAULT 0,
    "first_opened_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "stripe_event_id" VARCHAR(80),
    "type" VARCHAR(80) NOT NULL,
    "livemode" BOOLEAN,
    "signature_valid" BOOLEAN NOT NULL,
    "source" "PaymentEventSource" NOT NULL DEFAULT 'WEBHOOK',
    "result" "PaymentEventResult" NOT NULL DEFAULT 'PENDING',
    "payment_request_id" UUID,
    "body" JSONB,
    "error" VARCHAR(500),
    "stripe_created_at" TIMESTAMPTZ,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_connections" (
    "id" UUID NOT NULL,
    "catalog_id" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "waba_checks" JSONB NOT NULL DEFAULT '[]',
    "sync_status" VARCHAR(20) NOT NULL DEFAULT 'IDLE',
    "last_synced_at" TIMESTAMPTZ,
    "product_count" INTEGER NOT NULL DEFAULT 0,
    "last_sync_error" VARCHAR(500),
    "fill_store_id" UUID,
    "fill_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_filled_at" TIMESTAMPTZ,
    "fill_errors" JSONB NOT NULL DEFAULT '[]',
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "catalog_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_products" (
    "id" UUID NOT NULL,
    "retailer_id" VARCHAR(100) NOT NULL,
    "meta_product_id" VARCHAR(40),
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "price_minor" BIGINT,
    "sale_price_minor" BIGINT,
    "currency" CHAR(3),
    "image_url" TEXT,
    "url" TEXT,
    "availability" VARCHAR(30) NOT NULL,
    "visibility" VARCHAR(20),
    "review_status" VARCHAR(20),
    "removed_at" TIMESTAMPTZ,
    "fill_hash" CHAR(64),
    "store_ref" VARCHAR(80),
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_orders" (
    "id" UUID NOT NULL,
    "contact_id" UUID,
    "conversation_id" UUID,
    "chat_item_id" UUID,
    "catalog_id" VARCHAR(40) NOT NULL,
    "customer_text" VARCHAR(1000),
    "items" JSONB NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "mode" "ChatOrderMode" NOT NULL,
    "status" "ChatOrderStatus" NOT NULL DEFAULT 'RECEIVED',
    "edited_by_id" UUID,
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "category" "FormCategory" NOT NULL,
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL DEFAULT '{"screens":[]}',
    "mapping" JSONB NOT NULL DEFAULT '[]',
    "tag_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "changed_since_publish" BOOLEAN NOT NULL DEFAULT true,
    "current_version_id" UUID,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_versions" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "model" JSONB NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '[]',
    "tag_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "flow_json" JSONB NOT NULL,
    "meta_flows" JSONB NOT NULL DEFAULT '[]',
    "status" "FormVersionStatus" NOT NULL DEFAULT 'PUBLISHED',
    "published_by_id" UUID,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_answers" (
    "id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "form_version_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "conversation_id" UUID,
    "chat_item_id" UUID,
    "source" VARCHAR(20) NOT NULL,
    "flow_session_id" UUID,
    "answers" JSONB NOT NULL,
    "saved" JSONB NOT NULL DEFAULT '{}',
    "problems" JSONB NOT NULL DEFAULT '[]',
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_code_key" ON "payment_requests"("code");

-- CreateIndex
CREATE INDEX "payment_requests_contact_id_created_at_idx" ON "payment_requests"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_requests_campaign_id_status_idx" ON "payment_requests"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "payment_requests_source_created_at_idx" ON "payment_requests"("source", "created_at");

-- CreateIndex
CREATE INDEX "payment_requests_created_at_idx" ON "payment_requests"("created_at");

-- CreateIndex
CREATE INDEX "payment_requests_payment_intent_id_idx" ON "payment_requests"("payment_intent_id");

-- CreateIndex
CREATE INDEX "payment_requests_reference_idx" ON "payment_requests"("reference");

-- CreateIndex
CREATE INDEX "payment_requests_chat_order_id_idx" ON "payment_requests"("chat_order_id");

-- CreateIndex
CREATE INDEX "payment_requests_store_order_id_idx" ON "payment_requests"("store_order_id");

-- CreateIndex
CREATE INDEX "payment_requests_flow_session_id_idx" ON "payment_requests"("flow_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_stripe_event_id_key" ON "payment_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "payment_events_received_at_idx" ON "payment_events"("received_at");

-- CreateIndex
CREATE INDEX "payment_events_payment_request_id_idx" ON "payment_events"("payment_request_id");

-- CreateIndex
CREATE INDEX "payment_events_result_received_at_idx" ON "payment_events"("result", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_products_retailer_id_key" ON "catalog_products"("retailer_id");

-- CreateIndex
CREATE INDEX "catalog_products_removed_at_idx" ON "catalog_products"("removed_at");

-- CreateIndex
CREATE INDEX "chat_orders_status_created_at_idx" ON "chat_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "chat_orders_contact_id_created_at_idx" ON "chat_orders"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_orders_created_at_idx" ON "chat_orders"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "form_versions_form_id_number_key" ON "form_versions"("form_id", "number");

-- CreateIndex
CREATE INDEX "form_answers_form_id_submitted_at_idx" ON "form_answers"("form_id", "submitted_at");

-- CreateIndex
CREATE INDEX "form_answers_contact_id_submitted_at_idx" ON "form_answers"("contact_id", "submitted_at");

-- CreateIndex
CREATE INDEX "form_answers_submitted_at_idx" ON "form_answers"("submitted_at");

-- AddForeignKey
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_chat_order_tag_id_fkey" FOREIGN KEY ("chat_order_tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_chat_order_id_fkey" FOREIGN KEY ("chat_order_id") REFERENCES "chat_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_request_id_fkey" FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_connections" ADD CONSTRAINT "catalog_connections_fill_store_id_fkey" FOREIGN KEY ("fill_store_id") REFERENCES "store_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_orders" ADD CONSTRAINT "chat_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_orders" ADD CONSTRAINT "chat_orders_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_form_version_id_fkey" FOREIGN KEY ("form_version_id") REFERENCES "form_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AlterEnum (feature 008: flow sessions wait for a payment, a cart or a form answer)
ALTER TYPE "FlowWait" ADD VALUE 'PAYMENT';
ALTER TYPE "FlowWait" ADD VALUE 'ORDER';
ALTER TYPE "FlowWait" ADD VALUE 'FORM';

-- Hand-written (feature 008, data-model.md): one-row tables, partial indexes for the payments tick,
-- trigram search over the catalog copy (pg_trgm is enabled by the init migration), live form names,
-- and value checks.
CREATE UNIQUE INDEX "payment_gateways_one_row" ON "payment_gateways" ((true));
CREATE UNIQUE INDEX "payment_settings_one_row" ON "payment_settings" ((true));
CREATE UNIQUE INDEX "catalog_connections_one_row" ON "catalog_connections" ((true));
CREATE INDEX "payment_requests_waiting_expiry_idx" ON "payment_requests" ("expires_at") WHERE "status" = 'WAITING';
CREATE INDEX "payment_requests_next_reminder_idx" ON "payment_requests" ("next_reminder_at") WHERE "next_reminder_at" IS NOT NULL;
CREATE INDEX "payment_requests_expire_pending_idx" ON "payment_requests" ("updated_at") WHERE "session_expire_pending";
CREATE INDEX "catalog_products_name_trgm" ON "catalog_products" USING gin ("name" gin_trgm_ops);
CREATE INDEX "catalog_products_retailer_id_trgm" ON "catalog_products" USING gin ("retailer_id" gin_trgm_ops);
CREATE UNIQUE INDEX "forms_name_live_key" ON "forms" ("name") WHERE "status" <> 'ARCHIVED';
ALTER TABLE "payment_requests"
  ADD CONSTRAINT "payment_requests_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "payment_requests_refunded_check" CHECK ("refunded_minor" >= 0),
  ADD CONSTRAINT "payment_requests_reminders_check" CHECK ("reminders_sent" BETWEEN 0 AND 2);
ALTER TABLE "chat_orders" ADD CONSTRAINT "chat_orders_total_check" CHECK ("total_minor" >= 0);
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_number_check" CHECK ("number" >= 1);
