import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";

// ─── IPC response schemas ───────────────────────────────────────────────────

export const PeekedMessageSchema = z.object({
  messageId: z.string().nullable(),
  sequenceNumber: z.string().nullable().optional(),
  body: z.unknown(),
  subject: z.string().nullable(),
  contentType: z.string().nullable(),
  correlationId: z.string().nullable(),
  partitionKey: z.string().nullable(),
  traceParent: z.string().nullable(),
  applicationProperties: z.record(z.string(), z.unknown()).nullable(),
  enqueuedTimeUtc: z.string().nullable(),
  expiresAtUtc: z.string().nullable(),
  deadLetterReason: z.string().nullable().optional(),
  deadLetterErrorDescription: z.string().nullable().optional(),
  _source: z.string(),
});

export const PeekResultSchema = z.object({
  messages: z.array(PeekedMessageSchema),
  filename: z.string(),
  savedAt: z.string(),
});

export const ListEntitiesResultSchema = z.object({
  queues: z.array(z.string()),
  topics: z.record(z.string(), z.array(z.string())),
});

export const QueueCountResultSchema = z.object({
  name: z.string(),
  active: z.number(),
  dlq: z.number(),
});

export const SubscriptionCountResultSchema = z.object({
  topic: z.string(),
  subscription: z.string(),
  active: z.number(),
  dlq: z.number(),
});


export const ConnectionsConfigSchema = z.object({
  connections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connectionString: z.string(),
      env: z.record(z.string(), z.string()).default({}),
      environment: z.string().optional(),
      environmentColor: z.string().optional(),
    })
  ),
  activeConnectionId: z.string().nullable(),
});

// ─── Validated invoke ───────────────────────────────────────────────────────

/**
 * Type-safe invoke with runtime validation.
 * Calls the Tauri command and validates the response against the provided zod schema.
 * On validation failure, logs the error and throws a human-readable message.
 */
export async function safeInvoke<T>(
  command: string,
  schema: z.ZodType<T>,
  args?: Record<string, unknown>
): Promise<T> {
  const raw = await invoke(command, args);
  const result = schema.safeParse(raw);
  if (!result.success) {
    console.error(
      `[safeInvoke] ${command}: response validation failed`,
      result.error.issues
    );
    throw new Error(`Invalid response from ${command}`);
  }
  return result.data;
}
