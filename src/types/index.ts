export interface Connection {
  id: string;
  name: string;
  connectionString: string;
  env: Record<string, string>;
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

export interface QueueCountResult {
  name: string;
  active: number;
  dlq: number;
}

export interface SubscriptionCountResult {
  topic: string;
  subscription: string;
  active: number;
  dlq: number;
}

export interface EntityCountsResult {
  queues: QueueCountResult[];
  subscriptions: SubscriptionCountResult[];
}

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
  operation: "Browse" | "Send" | "Receive" | "Replay" | "Move";
  status: "running" | "success" | "error" | "stopped";
  errorMessage?: string;
}
