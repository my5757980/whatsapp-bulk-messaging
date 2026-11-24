-- Feature 005 (T061): indexes for retention and erasure.
-- Purging messages deletes their tracked links, and those delete their clicks (foreign key
-- cascades); without this index each tracked link would scan every click.
-- CreateIndex
CREATE INDEX "link_clicks_tracked_link_id_idx" ON "link_clicks"("tracked_link_id");

-- Enrolments are purged 12 months after they finished or left.
-- CreateIndex
CREATE INDEX "drip_enrolments_ended_at_idx" ON "drip_enrolments"("ended_at");
