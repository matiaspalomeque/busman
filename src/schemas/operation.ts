import { z } from "zod";

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SourceOutcomeSchema = z.object({
  sent: Count, settled: Count, sendUnconfirmed: Count, settlementUnconfirmed: Count,
});
export const OperationCountsSchema = SourceOutcomeSchema.extend({ sources: z.record(z.string(), SourceOutcomeSchema) });
export const OperationOutcomeSchema = z.object({
  version: z.literal(1), runId: z.string(), status: z.enum(["success", "error", "stopped", "unknown"]),
  startedAt: z.string(), finishedAt: z.string(), counts: OperationCountsSchema,
  errorCode: z.string().nullish(), errorMessage: z.string().nullish(),
});
export type OperationCounts = z.infer<typeof OperationCountsSchema>;
export type OperationOutcome = z.infer<typeof OperationOutcomeSchema>;
