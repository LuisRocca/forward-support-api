-- CreateIndex
CREATE INDEX "idx_tickets_reasignados" ON "tickets"("reassignment_count" DESC, "created_at" DESC);
