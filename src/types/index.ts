export interface Connection {
  id: string;
  name: string;
  connectionString: string;
  env: Record<string, string>;
  environment?: string;
  environmentColor?: string;
}

export interface ConnectionsConfig {
  connections: Connection[];
  activeConnectionId: string | null;
}

export type QueueMode = "normal" | "dlq" | "both";

export interface OutputLine {
  id: string;
  text: string;
  isStderr: boolean;
  elapsedMs: number;
}

export interface ProgressUpdate {
  text: string;
  elapsedMs: number;
}

export interface PeekedMessage {
  messageId: string | null;
  sequenceNumber?: string | null;
  body: unknown;
  subject: string | null;
  contentType: string | null;
  correlationId: string | null;
  partitionKey: string | null;
  traceParent: string | null;
  applicationProperties: Record<string, unknown> | null;
  enqueuedTimeUtc: string | null;
  expiresAtUtc: string | null;
  deadLetterReason?: string | null;
  deadLetterErrorDescription?: string | null;
  _source: string;
}

// Tauri event payload types (shared between hooks and components)
export interface ScriptOutputEvent {
  line: string;
  isStderr: boolean;
  elapsedMs: number;
}

export interface ScriptProgressEvent {
  text: string;
  elapsedMs: number;
}

export interface ScriptDoneEvent {
  exitCode: number;
  elapsedMs: number;
}

export type NavPage =
  | "connections"
  | "peek"
  | "search"
  | "move"
  | "empty"
  | "send";

export interface SendMessageDraft {
  body: string;
  contentType?: string;
  subject?: string;
  correlationId?: string;
  applicationProperties?: Record<string, unknown>;
}

export interface DownloadedFile {
  filename: string;
  savedAt: string;
  sizeBytes: number;
}

export interface PeekResult {
  messages: PeekedMessage[];
  filename: string;
  savedAt: string;
}


// Entity properties (inferred from Zod schemas in ipc.ts)
import type { z } from "zod";
import type {
  JsonPrimitiveMapSchema,
  ListSubscriptionRulesResultSchema,
  ManageSubscriptionRuleSchema,
  QueuePropertiesSchema,
  SubscriptionRuleActionSchema,
  SubscriptionRuleFilterSchema,
  SubscriptionRuleSchema,
  TopicPropertiesSchema,
  SubscriptionPropertiesSchema,
} from "../schemas/ipc";

export type JsonPrimitiveMap = z.infer<typeof JsonPrimitiveMapSchema>;
export type SubscriptionRuleAction = z.infer<typeof SubscriptionRuleActionSchema>;
export type SubscriptionRuleFilter = z.infer<typeof SubscriptionRuleFilterSchema>;
export type SubscriptionRule = z.infer<typeof SubscriptionRuleSchema>;
export type ListSubscriptionRulesResult = z.infer<typeof ListSubscriptionRulesResultSchema>;
export type ManageSubscriptionRule = z.infer<typeof ManageSubscriptionRuleSchema>;
export type QueueProperties = z.infer<typeof QueuePropertiesSchema>;
export type TopicProperties = z.infer<typeof TopicPropertiesSchema>;
export type SubscriptionProperties = z.infer<typeof SubscriptionPropertiesSchema>;

export type EntityProperties =
  | { kind: "queue"; data: QueueProperties }
  | { kind: "topic"; data: TopicProperties }
  | { kind: "subscription"; data: SubscriptionProperties };

export type ExplorerSelection =
  | {
      kind: "none";
      queueName: null;
      topicName: null;
      subscriptionName: null;
    }
  | {
      kind: "queue";
      queueName: string;
      topicName: null;
      subscriptionName: null;
    }
  | {
      kind: "subscription";
      queueName: null;
      topicName: string;
      subscriptionName: string;
    };

export interface EventLogEntry {
  id: string;
  time: string;
  namespace: string;
  entity: string;
  entityType: "Queue" | "Subscription" | "Topic";
  operation: "Browse" | "Send" | "Receive" | "Replay" | "Republish" | "Move" | "Create" | "Delete" | "DeleteMessage" | "ReplayMessage" | "MoveMessage";
  status: "running" | "success" | "error" | "stopped";
  errorMessage?: string;
}
