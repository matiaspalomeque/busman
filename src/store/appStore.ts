import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  Connection,
  EntityProperties,
  EventLogEntry,
  ExplorerSelection,
  NavPage,
  OutputLine,
  PeekedMessage,
  ProgressUpdate,
  SendMessageDraft,
} from "../types";

/** Internal key separator for subscription store entries: "topic\0subscription". */
export const SUBSCRIPTION_KEY_SEP = "\0";

export type SettingsTab = "connections" | "appearance" | "autoRefresh" | "notifications";

/** Timer handle for the changedEntities auto-clear. Module-scoped since the store is a singleton. */
let changedEntitiesTimer: ReturnType<typeof setTimeout> | null = null;

interface AppState {
  // Connections
  connections: Connection[];
  activeConnectionId: string | null;

  // Navigation
  currentPage: NavPage;
  explorerSelection: ExplorerSelection;

  // Script execution state
  isRunning: boolean;
  runId: string | null;
  outputLines: OutputLine[];
  progress: ProgressUpdate | null;

  // Peek results
  peekMessages: PeekedMessage[];
  peekFilename: string | null;
  lastPeekNormalMaxSeqNum: number | null;
  lastPeekDlqMaxSeqNum: number | null;

  // Worker availability
  workerAvailable: boolean | null;

  // Entity list cache (queues + topics/subscriptions for active connection)
  entities: { queues: string[]; topics: Record<string, string[]> } | null;
  entitiesLoading: boolean;
  entitiesError: string | null;

  // Message counts per entity (loaded progressively in parallel after entity list)
  queueCounts: Record<string, { active: number; dlq: number }>;
  subscriptionCounts: Record<string, { active: number; dlq: number }>;
  entityCountsLoading: number; // number of in-flight per-entity count requests

  // Entity properties (configuration + runtime details for selected entity)
  entityProperties: EntityProperties | null;
  entityPropertiesLoading: boolean;
  entityPropertiesError: string | null;
  entityPropertiesRequestNonce: number;

  // Send message draft (for Resend from Peek)
  sendDraft: SendMessageDraft | null;

  // Explorer UI state
  lastBrowseError: string | null;
  treeFilter: string;
  selectedMessage: PeekedMessage | null;
  gridFilters: {
    messageId: string;
    deadLetterReason: string;
    deadLetterErrorDescription: string;
    body: string;
  };
  gridPage: number;
  gridPageSize: number;
  eventLog: EventLogEntry[];
  isInsightsPanelOpen: boolean;
  isSendModalOpen: boolean;
  isMoveModalOpen: boolean;
  isSettingsModalOpen: boolean;
  settingsTab: SettingsTab;
  isAboutModalOpen: boolean;
  isCreateEntityModalOpen: boolean;
  isSubscriptionRulesModalOpen: boolean;
  deleteEntityTarget: { type: "queue" | "topic" | "subscription"; name: string; topicName?: string } | null;
  sidebarCollapsed: { queues: boolean; topics: boolean; system: boolean };

  // Sidebar width (persisted)
  sidebarWidth: number;

  // Properties panel width (persisted)
  propertiesPanelWidth: number;

  // Pinned entities (persisted per connection in localStorage)
  pinnedEntities: string[];

  // Theme
  isDark: boolean;

  // Language
  language: "en" | "es";

  // DLQ alert thresholds (persisted per connection in localStorage)
  dlqThresholds: Record<string, number>;
  // Whether desktop notifications for DLQ alerts are enabled (global, persisted)
  dlqNotificationsEnabled: boolean;

  // Auto-refresh (persisted)
  autoRefreshEnabled: boolean;
  autoRefreshInterval: 15 | 30 | 60;
  // Sparkline / trend-line visibility (persisted)
  sparklineEnabled: boolean;
  // Transient: entity keys whose counts changed on last auto-refresh (for flash animation)
  changedEntities: string[];

  // Session-only rolling history of active message counts per entity (for sparklines).
  // Keys: "queue:<name>" or "sub:<topic>/<subscription>" — same format as changedEntities.
  entityCountHistory: Record<string, number[]>;

  // Actions
  setConnections: (connections: Connection[]) => void;
  setActiveConnectionId: (id: string | null) => void;
  setCurrentPage: (page: NavPage) => void;
  setExplorerQueue: (queueName: string) => void;
  setExplorerSubscription: (topicName: string, subscriptionName: string) => void;
  clearExplorerSelection: () => void;
  setRunning: (running: boolean, runId?: string) => void;
  appendOutputLine: (line: string, isStderr: boolean, elapsedMs: number) => void;
  setProgress: (progress: ProgressUpdate | null) => void;
  clearOutput: () => void;
  setPeekResults: (messages: PeekedMessage[], filename: string) => void;
  appendPeekResults: (messages: PeekedMessage[], filename: string) => void;
  clearPeekResults: () => void;
  setWorkerAvailable: (available: boolean) => void;
  setEntities: (entities: { queues: string[]; topics: Record<string, string[]> } | null) => void;
  setEntitiesLoading: (loading: boolean) => void;
  setEntitiesError: (error: string | null) => void;
  batchSetCounts: (
    queues: { name: string; active: number; dlq: number }[],
    subscriptions: { topic: string; subscription: string; active: number; dlq: number }[]
  ) => void;
  clearEntityCounts: () => void;
  incrementCountsLoading: (n?: number) => void;
  decrementCountsLoading: () => void;
  setEntityPropertiesState: (props: EntityProperties | null, loading: boolean, error: string | null) => void;
  refreshEntityProperties: () => void;
  removeEntity: (type: "queue" | "topic" | "subscription", name: string, topicName?: string) => void;
  setSendDraft: (draft: SendMessageDraft | null) => void;
  setTreeFilter: (filter: string) => void;
  setSelectedMessage: (msg: PeekedMessage | null) => void;
  setGridFilter: (
    key: "messageId" | "deadLetterReason" | "deadLetterErrorDescription" | "body",
    value: string
  ) => void;
  clearGridFilters: () => void;
  setGridPage: (page: number) => void;
  setGridPageSize: (size: number) => void;
  addEventLogEntry: (entry: EventLogEntry) => void;
  updateEventLogEntry: (id: string, status: "success" | "error" | "stopped", errorMessage?: string) => void;
  setLastBrowseError: (err: string | null) => void;
  setIsInsightsPanelOpen: (open: boolean) => void;
  setIsSendModalOpen: (open: boolean) => void;
  setIsMoveModalOpen: (open: boolean) => void;
  setIsSettingsModalOpen: (open: boolean, tab?: SettingsTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setIsAboutModalOpen: (open: boolean) => void;
  setIsCreateEntityModalOpen: (open: boolean) => void;
  setIsSubscriptionRulesModalOpen: (open: boolean) => void;
  setDeleteEntityTarget: (target: { type: "queue" | "topic" | "subscription"; name: string; topicName?: string } | null) => void;
  toggleSidebarSection: (section: "queues" | "topics" | "system") => void;
  setSidebarWidth: (width: number) => void;
  setPropertiesPanelWidth: (width: number) => void;
  togglePin: (key: string) => void;
  setIsDark: (dark: boolean) => void;
  toggleDark: () => void;
  setLanguage: (lang: "en" | "es") => void;
  setDlqThreshold: (entityKey: string, threshold: number | null) => void;
  setDlqNotificationsEnabled: (enabled: boolean) => void;
  setAutoRefreshEnabled: (enabled: boolean) => void;
  setAutoRefreshInterval: (interval: 15 | 30 | 60) => void;
  setSparklineEnabled: (enabled: boolean) => void;
  setChangedEntities: (keys: string[]) => void;
  recordEntityCountHistory: () => void;
  clearEntityCountHistory: () => void;
}

/** Resets all entity-specific grid/peek state. Used when switching connection, queue, or subscription. */
function resetGridState(state: AppState): void {
  state.peekMessages = [];
  state.peekFilename = null;
  state.lastPeekNormalMaxSeqNum = null;
  state.lastPeekDlqMaxSeqNum = null;
  state.selectedMessage = null;
  state.gridFilters = { messageId: "", deadLetterReason: "", deadLetterErrorDescription: "", body: "" };
  state.gridPage = 1;
  state.lastBrowseError = null;
  state.entityProperties = null;
  state.entityPropertiesLoading = false;
  state.entityPropertiesError = null;
  state.isInsightsPanelOpen = false;
}

function computeMaxSeqNums(messages: PeekedMessage[]): { normal: number | null; dlq: number | null } {
  let normal: number | null = null;
  let dlq: number | null = null;
  for (const msg of messages) {
    if (msg.sequenceNumber == null) continue;
    const n = Number(msg.sequenceNumber);
    if (isNaN(n)) continue;
    if (msg._source.startsWith("Dead Letter")) {
      if (dlq === null || n > dlq) dlq = n;
    } else {
      if (normal === null || n > normal) normal = n;
    }
  }
  return { normal, dlq };
}

export const useAppStore = create<AppState>()(
  immer((set, get) => ({
    connections: [],
    activeConnectionId: null,
    currentPage: "connections",
    explorerSelection: {
      kind: "none",
      queueName: null,
      topicName: null,
      subscriptionName: null,
    },
    isRunning: false,
    runId: null,
    outputLines: [],
    progress: null,
    peekMessages: [],
    peekFilename: null,
    lastPeekNormalMaxSeqNum: null,
    lastPeekDlqMaxSeqNum: null,
    workerAvailable: null,
    entities: null,
    entitiesLoading: false,
    entitiesError: null,
    queueCounts: {},
    subscriptionCounts: {},
    entityCountsLoading: 0,
    entityProperties: null,
    entityPropertiesLoading: false,
    entityPropertiesError: null,
    entityPropertiesRequestNonce: 0,
    sendDraft: null,
    lastBrowseError: null,
    treeFilter: "",
    selectedMessage: null,
    gridFilters: { messageId: "", deadLetterReason: "", deadLetterErrorDescription: "", body: "" },
    gridPage: 1,
    gridPageSize: 100,
    eventLog: [],
    isInsightsPanelOpen: false,
    isSendModalOpen: false,
    isMoveModalOpen: false,
    isSettingsModalOpen: false,
    settingsTab: "connections" as SettingsTab,
    isAboutModalOpen: false,
    isCreateEntityModalOpen: false,
    isSubscriptionRulesModalOpen: false,
    deleteEntityTarget: null,
    sidebarCollapsed: { queues: false, topics: false, system: false },
    sidebarWidth: (() => {
      try {
        const stored = localStorage.getItem("sidebarWidth");
        if (stored) {
          const parsed = Number(stored);
          if (!isNaN(parsed) && parsed >= 180 && parsed <= 480) return parsed;
        }
      } catch {}
      return 240;
    })(),
    propertiesPanelWidth: (() => {
      try {
        const stored = localStorage.getItem("propertiesPanelWidth");
        if (stored) {
          const parsed = Number(stored);
          if (!isNaN(parsed) && parsed >= 200 && parsed <= 600) return parsed;
        }
      } catch {}
      return 320;
    })(),
    pinnedEntities: [],
    isDark: false,
    language: (() => {
      try {
        return (localStorage.getItem("language") as "en" | "es") ?? "en";
      } catch {
        return "en" as const;
      }
    })(),
    dlqThresholds: {},
    dlqNotificationsEnabled: (() => {
      try {
        return localStorage.getItem("dlqNotificationsEnabled") === "true";
      } catch {
        return false;
      }
    })(),
    autoRefreshEnabled: (() => {
      try {
        return localStorage.getItem("autoRefreshEnabled") === "true";
      } catch {
        return false;
      }
    })(),
    autoRefreshInterval: (() => {
      try {
        const stored = Number(localStorage.getItem("autoRefreshInterval"));
        if (stored === 15 || stored === 30 || stored === 60) return stored;
      } catch {}
      return 30 as const;
    })(),
    sparklineEnabled: (() => {
      try {
        const stored = localStorage.getItem("sparklineEnabled");
        return stored === null ? true : stored === "true";
      } catch {
        return true;
      }
    })(),
    changedEntities: [],
    entityCountHistory: {},

    setConnections: (connections) =>
      set((state) => {
        state.connections = [...connections].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
      }),

    setActiveConnectionId: (id) =>
      set((state) => {
        state.activeConnectionId = id;
        // Clear cached entities when connection changes
        state.entities = null;
        state.entitiesError = null;
        state.queueCounts = {};
        state.subscriptionCounts = {};
        state.entityCountsLoading = 0;
        state.entityCountHistory = {};
        state.isSubscriptionRulesModalOpen = false;
        state.explorerSelection = {
          kind: "none",
          queueName: null,
          topicName: null,
          subscriptionName: null,
        };
        resetGridState(state);
        // Load pins for this connection from localStorage
        if (id !== null) {
          try {
            const stored = localStorage.getItem(`pins:${id}`);
            const parsed: unknown = stored ? JSON.parse(stored) : [];
            state.pinnedEntities = Array.isArray(parsed)
              ? parsed.filter((x): x is string => typeof x === "string")
              : [];
          } catch {
            state.pinnedEntities = [];
          }
          // Load DLQ thresholds for this connection from localStorage
          try {
            const storedThresholds = localStorage.getItem(`dlqThresholds:${id}`);
            const parsedThresholds: unknown = storedThresholds ? JSON.parse(storedThresholds) : {};
            state.dlqThresholds =
              typeof parsedThresholds === "object" && parsedThresholds !== null && !Array.isArray(parsedThresholds)
                ? Object.fromEntries(
                    Object.entries(parsedThresholds as Record<string, unknown>).filter(
                      (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0
                    )
                  )
                : {};
          } catch {
            state.dlqThresholds = {};
          }
        } else {
          state.pinnedEntities = [];
          state.dlqThresholds = {};
        }
        if (id === null) {
          state.currentPage = "connections";
        } else {
          state.currentPage = "peek";
        }
      }),

    setCurrentPage: (page) =>
      set((state) => {
        state.currentPage = page;
      }),

    setExplorerQueue: (queueName) =>
      set((state) => {
        // Skip reset if re-selecting the same entity
        if (state.explorerSelection.kind === "queue" && state.explorerSelection.queueName === queueName) return;
        state.explorerSelection = {
          kind: "queue",
          queueName,
          topicName: null,
          subscriptionName: null,
        };
        state.isSubscriptionRulesModalOpen = false;
        resetGridState(state);
      }),

    setExplorerSubscription: (topicName, subscriptionName) =>
      set((state) => {
        // Skip reset if re-selecting the same entity
        if (
          state.explorerSelection.kind === "subscription" &&
          state.explorerSelection.topicName === topicName &&
          state.explorerSelection.subscriptionName === subscriptionName
        )
          return;
        state.explorerSelection = {
          kind: "subscription",
          queueName: null,
          topicName,
          subscriptionName,
        };
        state.isSubscriptionRulesModalOpen = false;
        resetGridState(state);
      }),

    clearExplorerSelection: () =>
      set((state) => {
        state.explorerSelection = {
          kind: "none",
          queueName: null,
          topicName: null,
          subscriptionName: null,
        };
        state.isSubscriptionRulesModalOpen = false;
      }),

    setRunning: (running, runId) =>
      set((state) => {
        state.isRunning = running;
        state.runId = runId ?? null;
        if (!running) {
          state.progress = null;
        }
      }),

    appendOutputLine: (line, isStderr, elapsedMs) =>
      set((state) => {
        state.outputLines.push({
          id: crypto.randomUUID(),
          text: line,
          isStderr,
          elapsedMs,
        });
        // Cap at 2000 lines to prevent unbounded memory growth.
        if (state.outputLines.length > 2000) {
          state.outputLines.splice(0, state.outputLines.length - 2000);
        }
      }),

    setProgress: (progress) =>
      set((state) => {
        state.progress = progress;
      }),

    clearOutput: () =>
      set((state) => {
        state.outputLines = [];
        state.progress = null;
      }),

    setPeekResults: (messages, filename) =>
      set((state) => {
        state.peekMessages = messages;
        state.peekFilename = filename;
        const { normal: n1, dlq: d1 } = computeMaxSeqNums(messages);
        state.lastPeekNormalMaxSeqNum = n1;
        state.lastPeekDlqMaxSeqNum = d1;
      }),

    appendPeekResults: (messages, filename) =>
      set((state) => {
        state.peekMessages = [...state.peekMessages, ...messages];
        state.peekFilename = filename;
        const { normal: n2, dlq: d2 } = computeMaxSeqNums(state.peekMessages);
        state.lastPeekNormalMaxSeqNum = n2;
        state.lastPeekDlqMaxSeqNum = d2;
      }),

    clearPeekResults: () =>
      set((state) => {
        state.peekMessages = [];
        state.peekFilename = null;
        state.lastPeekNormalMaxSeqNum = null;
        state.lastPeekDlqMaxSeqNum = null;
      }),

    setWorkerAvailable: (available) =>
      set((state) => {
        state.workerAvailable = available;
      }),

    setEntities: (entities) =>
      set((state) => {
        state.entities = entities;
      }),

    setEntitiesLoading: (loading) =>
      set((state) => {
        state.entitiesLoading = loading;
      }),

    setEntitiesError: (error) =>
      set((state) => {
        state.entitiesError = error;
      }),

    batchSetCounts: (queues, subscriptions) =>
      set((state) => {
        for (const q of queues) {
          const existing = state.queueCounts[q.name];
          if (!existing || existing.active !== q.active || existing.dlq !== q.dlq) {
            state.queueCounts[q.name] = { active: q.active, dlq: q.dlq };
          }
        }
        for (const s of subscriptions) {
          const key = `${s.topic}${SUBSCRIPTION_KEY_SEP}${s.subscription}`;
          const existing = state.subscriptionCounts[key];
          if (!existing || existing.active !== s.active || existing.dlq !== s.dlq) {
            state.subscriptionCounts[key] = { active: s.active, dlq: s.dlq };
          }
        }
      }),

    clearEntityCounts: () =>
      set((state) => {
        state.queueCounts = {};
        state.subscriptionCounts = {};
        state.entityCountsLoading = 0;
      }),

    incrementCountsLoading: (n = 1) =>
      set((state) => {
        state.entityCountsLoading += n;
      }),

    decrementCountsLoading: () =>
      set((state) => {
        state.entityCountsLoading = Math.max(0, state.entityCountsLoading - 1);
      }),

    setEntityPropertiesState: (props, loading, error) =>
      set((state) => {
        state.entityProperties = props;
        state.entityPropertiesLoading = loading;
        state.entityPropertiesError = error;
      }),

    refreshEntityProperties: () =>
      set((state) => {
        state.entityPropertiesRequestNonce += 1;
      }),

    removeEntity: (type, name, topicName) =>
      set((state) => {
        if (!state.entities) return;
        if (type === "queue") {
          state.entities = {
            ...state.entities,
            queues: state.entities.queues.filter((q) => q !== name),
          };
          delete state.queueCounts[name];
        } else if (type === "topic") {
          const { [name]: _, ...remainingTopics } = state.entities.topics;
          state.entities = { ...state.entities, topics: remainingTopics };
          for (const key of Object.keys(state.subscriptionCounts)) {
            if (key.startsWith(`${name}${SUBSCRIPTION_KEY_SEP}`)) {
              delete state.subscriptionCounts[key];
            }
          }
        } else if (type === "subscription" && topicName) {
          const subs = state.entities.topics[topicName];
          if (subs) {
            state.entities = {
              ...state.entities,
              topics: {
                ...state.entities.topics,
                [topicName]: subs.filter((s) => s !== name),
              },
            };
          }
          delete state.subscriptionCounts[`${topicName}${SUBSCRIPTION_KEY_SEP}${name}`];
        }
      }),

    setSendDraft: (draft) =>
      set((state) => {
        state.sendDraft = draft;
      }),

    setTreeFilter: (filter) =>
      set((state) => {
        state.treeFilter = filter;
      }),

    setSelectedMessage: (msg) =>
      set((state) => {
        state.selectedMessage = msg;
      }),

    setGridFilter: (key, value) =>
      set((state) => {
        state.gridFilters[key] = value;
        state.gridPage = 1;
      }),

    clearGridFilters: () =>
      set((state) => {
        state.gridFilters = { messageId: "", deadLetterReason: "", deadLetterErrorDescription: "", body: "" };
        state.gridPage = 1;
      }),

    setGridPage: (page) =>
      set((state) => {
        state.gridPage = page;
      }),

    setGridPageSize: (size) =>
      set((state) => {
        state.gridPageSize = size;
        state.gridPage = 1;
      }),

    addEventLogEntry: (entry) =>
      set((state) => {
        state.eventLog.unshift(entry);
        if (state.eventLog.length > 500) {
          state.eventLog.length = 500;
        }
      }),

    updateEventLogEntry: (id, status, errorMessage) =>
      set((state) => {
        const entry = state.eventLog.find((e) => e.id === id);
        if (entry) {
          entry.status = status;
          if (errorMessage) entry.errorMessage = errorMessage;
        }
      }),

    setLastBrowseError: (err) =>
      set((state) => {
        state.lastBrowseError = err;
      }),

    setIsInsightsPanelOpen: (open) =>
      set((state) => {
        state.isInsightsPanelOpen = open;
      }),

    setIsSendModalOpen: (open) =>
      set((state) => {
        state.isSendModalOpen = open;
      }),

    setIsMoveModalOpen: (open) =>
      set((state) => {
        state.isMoveModalOpen = open;
      }),

    setIsSettingsModalOpen: (open, tab) =>
      set((state) => {
        state.isSettingsModalOpen = open;
        if (open && tab) {
          state.settingsTab = tab;
        } else if (!open) {
          state.settingsTab = "connections";
        }
      }),

    setSettingsTab: (tab) =>
      set((state) => {
        state.settingsTab = tab;
      }),

    setIsAboutModalOpen: (open) =>
      set((state) => {
        state.isAboutModalOpen = open;
      }),

    setIsCreateEntityModalOpen: (open) =>
      set((state) => {
        state.isCreateEntityModalOpen = open;
      }),

    setIsSubscriptionRulesModalOpen: (open) =>
      set((state) => {
        state.isSubscriptionRulesModalOpen = open;
      }),

    setDeleteEntityTarget: (target) =>
      set((state) => {
        state.deleteEntityTarget = target;
      }),

    toggleSidebarSection: (section) =>
      set((state) => {
        state.sidebarCollapsed[section] = !state.sidebarCollapsed[section];
      }),

    setSidebarWidth: (width) => {
      try {
        localStorage.setItem("sidebarWidth", String(width));
      } catch {}
      set((state) => {
        state.sidebarWidth = width;
      });
    },

    setPropertiesPanelWidth: (width) => {
      try {
        localStorage.setItem("propertiesPanelWidth", String(width));
      } catch {}
      set((state) => {
        state.propertiesPanelWidth = width;
      });
    },

    togglePin: (key) => {
      set((state) => {
        const idx = state.pinnedEntities.indexOf(key);
        if (idx >= 0) {
          state.pinnedEntities.splice(idx, 1);
        } else {
          state.pinnedEntities.push(key);
        }
      });
      const { pinnedEntities: pins, activeConnectionId: connId } = get();
      if (connId) {
        try {
          localStorage.setItem(`pins:${connId}`, JSON.stringify(pins));
        } catch {}
      }
    },

    setIsDark: (dark) =>
      set((state) => {
        state.isDark = dark;
      }),

    toggleDark: () =>
      set((state) => {
        state.isDark = !state.isDark;
      }),

    setLanguage: (lang) =>
      set((state) => {
        state.language = lang;
      }),

    setDlqThreshold: (entityKey, threshold) => {
      set((state) => {
        if (threshold === null || threshold <= 0) {
          const { [entityKey]: _, ...rest } = state.dlqThresholds;
          state.dlqThresholds = rest;
        } else {
          state.dlqThresholds = { ...state.dlqThresholds, [entityKey]: threshold };
        }
      });
      const { dlqThresholds, activeConnectionId: connId } = get();
      if (connId) {
        try {
          localStorage.setItem(`dlqThresholds:${connId}`, JSON.stringify(dlqThresholds));
        } catch {}
      }
    },

    setDlqNotificationsEnabled: (enabled) => {
      try {
        localStorage.setItem("dlqNotificationsEnabled", String(enabled));
      } catch {}
      set((state) => {
        state.dlqNotificationsEnabled = enabled;
      });
    },

    setAutoRefreshEnabled: (enabled) => {
      try {
        localStorage.setItem("autoRefreshEnabled", String(enabled));
      } catch {}
      set((state) => {
        state.autoRefreshEnabled = enabled;
      });
    },

    setAutoRefreshInterval: (interval) => {
      try {
        localStorage.setItem("autoRefreshInterval", String(interval));
      } catch {}
      set((state) => {
        state.autoRefreshInterval = interval;
      });
    },

    setChangedEntities: (keys) => {
      if (changedEntitiesTimer !== null) {
        clearTimeout(changedEntitiesTimer);
        changedEntitiesTimer = null;
      }
      set((state) => {
        state.changedEntities = keys;
      });
      if (keys.length > 0) {
        changedEntitiesTimer = setTimeout(() => {
          changedEntitiesTimer = null;
          if (get().changedEntities.length > 0) {
            set((state) => {
              state.changedEntities = [];
            });
          }
        }, 2000);
      }
    },

    setSparklineEnabled: (enabled) => {
      try {
        localStorage.setItem("sparklineEnabled", String(enabled));
      } catch {}
      set((state) => {
        state.sparklineEnabled = enabled;
      });
    },

    recordEntityCountHistory: () =>
      set((state) => {
        const MAX = 20;
        for (const [name, counts] of Object.entries(state.queueCounts)) {
          const key = `queue:${name}`;
          if (!state.entityCountHistory[key]) state.entityCountHistory[key] = [];
          state.entityCountHistory[key].push(counts.active);
          if (state.entityCountHistory[key].length > MAX) {
            state.entityCountHistory[key].splice(0, state.entityCountHistory[key].length - MAX);
          }
        }
        for (const [rawKey, counts] of Object.entries(state.subscriptionCounts)) {
          const key = `sub:${rawKey.replace(SUBSCRIPTION_KEY_SEP, "/")}`;
          if (!state.entityCountHistory[key]) state.entityCountHistory[key] = [];
          state.entityCountHistory[key].push(counts.active);
          if (state.entityCountHistory[key].length > MAX) {
            state.entityCountHistory[key].splice(0, state.entityCountHistory[key].length - MAX);
          }
        }
      }),

    clearEntityCountHistory: () =>
      set((state) => {
        state.entityCountHistory = {};
      }),
  }))
);

// Selectors
export const selectActiveConnection = (state: AppState) =>
  state.connections.find((c) => c.id === state.activeConnectionId) ?? null;
