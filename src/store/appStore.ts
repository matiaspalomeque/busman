import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  Connection,
  EntityCountsResult,
  EventLogEntry,
  ExplorerSelection,
  NavPage,
  OutputLine,
  PeekedMessage,
  ProgressUpdate,
  SendMessageDraft,
} from "../types";

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

  // Message counts per entity (loaded in background after entity list)
  entityCounts: EntityCountsResult | null;
  entityCountsLoading: boolean;

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
  isSendModalOpen: boolean;
  isMoveModalOpen: boolean;
  isConnectionsModalOpen: boolean;
  isAboutModalOpen: boolean;
  sidebarCollapsed: { queues: boolean; topics: boolean; system: boolean };

  // Sidebar width (persisted)
  sidebarWidth: number;

  // Theme
  isDark: boolean;

  // Language
  language: "en" | "es";

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
  setEntityCounts: (counts: EntityCountsResult | null) => void;
  setEntityCountsLoading: (loading: boolean) => void;
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
  setIsSendModalOpen: (open: boolean) => void;
  setIsMoveModalOpen: (open: boolean) => void;
  setIsConnectionsModalOpen: (open: boolean) => void;
  setIsAboutModalOpen: (open: boolean) => void;
  toggleSidebarSection: (section: "queues" | "topics" | "system") => void;
  setSidebarWidth: (width: number) => void;
  setIsDark: (dark: boolean) => void;
  toggleDark: () => void;
  setLanguage: (lang: "en" | "es") => void;
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
  immer((set) => ({
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
    entityCounts: null,
    entityCountsLoading: false,
    sendDraft: null,
    lastBrowseError: null,
    treeFilter: "",
    selectedMessage: null,
    gridFilters: { messageId: "", deadLetterReason: "", deadLetterErrorDescription: "", body: "" },
    gridPage: 1,
    gridPageSize: 100,
    eventLog: [],
    isSendModalOpen: false,
    isMoveModalOpen: false,
    isConnectionsModalOpen: false,
    isAboutModalOpen: false,
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
    isDark: false,
    language: (() => {
      try {
        return (localStorage.getItem("language") as "en" | "es") ?? "en";
      } catch {
        return "en" as const;
      }
    })(),

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
        state.entityCounts = null;
        state.entityCountsLoading = false;
        state.explorerSelection = {
          kind: "none",
          queueName: null,
          topicName: null,
          subscriptionName: null,
        };
        // Clear entity-specific grid state
        state.peekMessages = [];
        state.peekFilename = null;
        state.lastPeekNormalMaxSeqNum = null;
        state.lastPeekDlqMaxSeqNum = null;
        state.selectedMessage = null;
        state.gridFilters = { messageId: "", deadLetterReason: "", deadLetterErrorDescription: "", body: "" };
        state.gridPage = 1;
        state.lastBrowseError = null;
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
        // Clear entity-specific grid state
        state.peekMessages = [];
        state.peekFilename = null;
        state.lastPeekNormalMaxSeqNum = null;
        state.lastPeekDlqMaxSeqNum = null;
        state.selectedMessage = null;
        state.gridFilters = { messageId: "", deadLetterReason: "", deadLetterErrorDescription: "", body: "" };
        state.gridPage = 1;
        state.lastBrowseError = null;
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
        // Clear entity-specific grid state
        state.peekMessages = [];
        state.peekFilename = null;
        state.lastPeekNormalMaxSeqNum = null;
        state.lastPeekDlqMaxSeqNum = null;
        state.selectedMessage = null;
        state.gridFilters = { messageId: "", deadLetterReason: "", deadLetterErrorDescription: "", body: "" };
        state.gridPage = 1;
        state.lastBrowseError = null;
      }),

    clearExplorerSelection: () =>
      set((state) => {
        state.explorerSelection = {
          kind: "none",
          queueName: null,
          topicName: null,
          subscriptionName: null,
        };
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

    setEntityCounts: (counts) =>
      set((state) => {
        state.entityCounts = counts;
      }),

    setEntityCountsLoading: (loading) =>
      set((state) => {
        state.entityCountsLoading = loading;
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

    setIsSendModalOpen: (open) =>
      set((state) => {
        state.isSendModalOpen = open;
      }),

    setIsMoveModalOpen: (open) =>
      set((state) => {
        state.isMoveModalOpen = open;
      }),

    setIsConnectionsModalOpen: (open) =>
      set((state) => {
        state.isConnectionsModalOpen = open;
      }),

    setIsAboutModalOpen: (open) =>
      set((state) => {
        state.isAboutModalOpen = open;
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
  }))
);

// Selectors
export const selectActiveConnection = (state: AppState) =>
  state.connections.find((c) => c.id === state.activeConnectionId) ?? null;
