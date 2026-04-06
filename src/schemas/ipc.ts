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

export const TopicSubscriptionCountsResultSchema = z.object({
  topic: z.string(),
  subscriptions: z.array(SubscriptionCountResultSchema),
});

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean()]);

export const JsonPrimitiveMapSchema = z.record(z.string(), JsonPrimitiveSchema);

export const SubscriptionRuleActionSchema = z.object({
  expression: z.string(),
  parameters: JsonPrimitiveMapSchema.default({}),
});

export const SubscriptionRuleFilterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sql"),
    expression: z.string(),
    parameters: JsonPrimitiveMapSchema.default({}),
  }),
  z.object({
    kind: z.literal("correlation"),
    contentType: z.string().nullable(),
    correlationId: z.string().nullable(),
    messageId: z.string().nullable(),
    replyTo: z.string().nullable(),
    replyToSessionId: z.string().nullable(),
    sessionId: z.string().nullable(),
    subject: z.string().nullable(),
    to: z.string().nullable(),
    applicationProperties: JsonPrimitiveMapSchema.default({}),
  }),
  z.object({
    kind: z.literal("true"),
  }),
  z.object({
    kind: z.literal("false"),
  }),
]);

export const SubscriptionRuleSchema = z.object({
  name: z.string(),
  filter: SubscriptionRuleFilterSchema,
  action: SubscriptionRuleActionSchema.nullable(),
});

export const ListSubscriptionRulesResultSchema = z.object({
  topicName: z.string(),
  subscriptionName: z.string(),
  rules: z.array(SubscriptionRuleSchema),
});

export const ManageSubscriptionRuleSchema = z.object({
  name: z.string().trim().min(1),
  filter: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("sql"),
      expression: z.string().trim().min(1),
      parameters: JsonPrimitiveMapSchema.default({}),
    }),
    z.object({
      kind: z.literal("correlation"),
      contentType: z.string().nullable(),
      correlationId: z.string().nullable(),
      messageId: z.string().nullable(),
      replyTo: z.string().nullable(),
      replyToSessionId: z.string().nullable(),
      sessionId: z.string().nullable(),
      subject: z.string().nullable(),
      to: z.string().nullable(),
      applicationProperties: JsonPrimitiveMapSchema.default({}),
    }),
    z.object({
      kind: z.literal("true"),
    }),
    z.object({
      kind: z.literal("false"),
    }),
  ]),
  action: z.object({
    expression: z.string().trim().min(1),
    parameters: JsonPrimitiveMapSchema.default({}),
  }).nullable(),
});

// ─── Entity properties schemas ─────────────────────────────────────────────

export const QueuePropertiesSchema = z.object({
  name: z.string(),
  lockDuration: z.string().nullable(),
  maxSizeInMegabytes: z.number().nullable(),
  requiresDuplicateDetection: z.boolean().nullable(),
  requiresSession: z.boolean().nullable(),
  defaultMessageTimeToLive: z.string().nullable(),
  deadLetteringOnMessageExpiration: z.boolean().nullable(),
  maxDeliveryCount: z.number().nullable(),
  enablePartitioning: z.boolean().nullable(),
  enableBatchedOperations: z.boolean().nullable(),
  status: z.string().nullable(),
  autoDeleteOnIdle: z.string().nullable(),
  forwardTo: z.string().nullable(),
  forwardDeadLetteredMessagesTo: z.string().nullable(),
  maxMessageSizeInKilobytes: z.number().nullable(),
  // Runtime
  sizeInBytes: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  accessedAt: z.string(),
  totalMessageCount: z.number(),
  activeMessageCount: z.number(),
  deadLetterMessageCount: z.number(),
  scheduledMessageCount: z.number(),
  transferMessageCount: z.number(),
  transferDeadLetterMessageCount: z.number(),
});

export const TopicPropertiesSchema = z.object({
  name: z.string(),
  maxSizeInMegabytes: z.number().nullable(),
  requiresDuplicateDetection: z.boolean().nullable(),
  defaultMessageTimeToLive: z.string().nullable(),
  enablePartitioning: z.boolean().nullable(),
  enableBatchedOperations: z.boolean().nullable(),
  status: z.string().nullable(),
  autoDeleteOnIdle: z.string().nullable(),
  supportOrdering: z.boolean().nullable(),
  maxMessageSizeInKilobytes: z.number().nullable(),
  // Runtime
  sizeInBytes: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  accessedAt: z.string(),
  subscriptionCount: z.number(),
  scheduledMessageCount: z.number(),
});

export const SubscriptionPropertiesSchema = z.object({
  name: z.string(),
  topicName: z.string(),
  lockDuration: z.string().nullable(),
  requiresSession: z.boolean().nullable(),
  defaultMessageTimeToLive: z.string().nullable(),
  deadLetteringOnMessageExpiration: z.boolean().nullable(),
  enableDeadLetteringOnFilterEvaluationExceptions: z.boolean().nullable(),
  maxDeliveryCount: z.number().nullable(),
  status: z.string().nullable(),
  autoDeleteOnIdle: z.string().nullable(),
  forwardTo: z.string().nullable(),
  forwardDeadLetteredMessagesTo: z.string().nullable(),
  enableBatchedOperations: z.boolean().nullable(),
  // Runtime
  createdAt: z.string(),
  updatedAt: z.string(),
  accessedAt: z.string(),
  totalMessageCount: z.number(),
  activeMessageCount: z.number(),
  deadLetterMessageCount: z.number(),
  transferMessageCount: z.number(),
  transferDeadLetterMessageCount: z.number(),
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
