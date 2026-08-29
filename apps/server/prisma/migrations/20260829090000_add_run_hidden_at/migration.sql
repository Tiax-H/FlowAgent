-- 运行记录软删：给 workflow_runs 加 hiddenAt 列（软删标记）。
-- 硬约束：workflow_events 为 append-only，禁止 UPDATE/DELETE，删除运行不清理任何事件。
-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN "hiddenAt" DATETIME;
