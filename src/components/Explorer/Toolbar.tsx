import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useConnections } from "../../hooks/useConnections";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useScript } from "../../hooks/useScript";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";
import { exitCodeToStatus } from "../../utils/exitCode";
import { safeColor } from "../../utils/color";
import type { PeekResult, QueueMode, Connection } from "../../types";
import {
  buildEmptyMessagesParams,
  buildReplayParams,
  buildRepublishSubscriptionDlqParams,
  canManageRulesSelection,
  canReplaySelection,
  canRepublishSelection,
  getDisplayEntity,
} from "./toolbarActions";

// ─── Toolbar button ───────────────────────────────────────────────────────────

interface ToolbarButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  primary?: boolean;
  warn?: boolean;
}

function ToolbarButton({ label, icon, onClick, disabled, title, danger, primary, warn }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded transition-colors",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        danger
          ? "border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
          : warn
            ? "border-orange-400 dark:border-orange-600 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20"
            : primary
              ? "border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
              : "border-zinc-300 dark:border-zinc-600 text-azure-secondary dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Confirm modal ────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  title: string;
  message: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ title, message, danger, onConfirm, onCancel }: ConfirmModalProps) {
  const { t } = useTranslation();
  useEscapeKey(onCancel);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div role="dialog" aria-modal="true" className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-sm mx-4 overflow-hidden border border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className={[
            "text-sm font-semibold flex items-center gap-2",
            danger ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400",
          ].join(" ")}>
            <Icon name={danger ? "trash" : "move"} size={15} />
            {title}
          </h2>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="px-4 py-4">
          <p className="text-xs text-zinc-600 dark:text-zinc-300">{message}</p>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            {t("explorer.toolbar.cancel")}
          </button>
          <button
            onClick={onConfirm}
            className={[
              "px-4 py-1.5 text-xs rounded text-white",
              danger ? "bg-red-600 hover:bg-red-700" : "bg-amber-500 hover:bg-amber-600",
            ].join(" ")}
          >
            {t("explorer.toolbar.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mode selector ────────────────────────────────────────────────────────────

const MODES: QueueMode[] = ["dlq", "normal", "both"];

interface ModeSelectorProps {
  value: QueueMode;
  onChange: (m: QueueMode) => void;
}

function ModeSelector({ value, onChange }: ModeSelectorProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center border border-zinc-300 dark:border-zinc-600 rounded overflow-hidden">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={[
            "px-2.5 py-1.5 text-xs transition-colors",
            value === m
              ? "bg-azure-primary text-white"
              : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700",
          ].join(" ")}
        >
          {t(`modeSelector.${m}`)}
        </button>
      ))}
    </div>
  );
}

// ─── Connection selector ──────────────────────────────────────────────────────

const ENV_ORDER = ["prod", "staging", "dev"];

function buildGroups(items: Connection[]) {
  const buckets: Record<string, Connection[]> = {};
  for (const c of items) {
    const key = c.environment ?? "";
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(c);
  }
  return [
    ...ENV_ORDER.filter((e) => buckets[e]?.length).map((e) => ({ key: e, items: buckets[e]! })),
    ...(buckets[""]?.length ? [{ key: "", items: buckets[""] }] : []),
  ];
}

function ConnectionSelector() {
  const { t } = useTranslation();
  const { connections } = useAppStore();
  const conn = useAppStore(selectActiveConnection);
  const { setActive } = useConnections();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (connections.length === 0) {
    return <span className="text-xs text-zinc-400">{t("explorer.toolbar.noConnections")}</span>;
  }

  const filtered = search
    ? connections.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : connections;

  const groups = buildGroups(filtered);
  const showHeaders = groups.length > 1;

  const handleSelect = (id: string) => {
    void setActive(id);
    setOpen(false);
    setSearch("");
  };

  const envLabel = (key: string) =>
    key
      ? t(`explorer.connectionsModal.env.${key}`, key)
      : t("explorer.connectionsModal.groupOther", "Other");

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200 max-w-48 transition-colors"
      >
        {conn ? (
          <>
            {safeColor(conn.environmentColor) && (
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: safeColor(conn.environmentColor) }}
              />
            )}
            <span className="truncate">{conn.name}</span>
          </>
        ) : (
          <span className="text-zinc-400 truncate">{t("explorer.toolbar.selectConnection")}</span>
        )}
        <Icon name="chevronDown" size={10} className="shrink-0 opacity-50 ml-auto pl-0.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg z-50 overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-zinc-100 dark:border-zinc-700">
            <div className="relative">
              <Icon
                name="search"
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
              />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (search) setSearch("");
                    else setOpen(false);
                  }
                }}
                placeholder={t("explorer.toolbar.searchConnections")}
                className="w-full text-xs pl-6 pr-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
              />
            </div>
          </div>

          {/* List */}
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="text-xs text-zinc-400 px-3 py-2">
                {t("explorer.toolbar.noSearchResults")}
              </p>
            ) : (
              groups.map(({ key, items }) => (
                <div key={key || "__other"}>
                  {showHeaders && (
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 px-3 pt-2 pb-0.5">
                      {envLabel(key)}
                    </p>
                  )}
                  {items.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => handleSelect(c.id)}
                      className={[
                        "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                        conn?.id === c.id
                          ? "bg-azure-primary/5 text-azure-primary"
                          : "text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/60",
                      ].join(" ")}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          backgroundColor:
                            safeColor(c.environmentColor) ?? "rgb(161 161 170)",
                        }}
                      />
                      <span className="truncate flex-1 text-xs">{c.name}</span>
                      {conn?.id === c.id && (
                        <Icon name="chevronRight" size={10} className="shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

export function Toolbar() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const {
    explorerSelection,
    peekMessages,
    lastPeekNormalMaxSeqNum,
    lastPeekDlqMaxSeqNum,
    isRunning,
    isSendModalOpen,
    setIsSendModalOpen,
    setIsMoveModalOpen,
    setIsSettingsModalOpen,
    setIsSubscriptionRulesModalOpen,
    clearPeekResults,
    setPeekResults,
    appendPeekResults,
    setSelectedMessage,
    clearGridFilters,
    setGridPage,
    addEventLogEntry,
    updateEventLogEntry,
    setLastBrowseError,
  } = useAppStore();
  const { runOperation } = useScript();

  const [peekMode, setPeekMode] = useState<QueueMode>("dlq");
  const [peekCount, setPeekCount] = useState(100);
  const [browsing, setBrowsing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirm, setConfirm] = useState<"receive" | "replay" | "republish" | null>(null);

  const hasSelection = explorerSelection.kind !== "none";
  const entityName =
    explorerSelection.kind === "queue"
      ? explorerSelection.queueName
      : explorerSelection.kind === "subscription"
        ? explorerSelection.subscriptionName
        : null;
  const entityType =
    explorerSelection.kind === "queue"
      ? ("Queue" as const)
      : explorerSelection.kind === "subscription"
        ? ("Subscription" as const)
        : ("Queue" as const);

  const displayEntity = getDisplayEntity(explorerSelection);
  const canReplay = canReplaySelection(explorerSelection);
  const canRepublish = canRepublishSelection(explorerSelection);
  const canManageRules = canManageRulesSelection(explorerSelection);

  const busy = browsing || loadingMore || isRunning;

  // ── Browse / Peek ──────────────────────────────────────────────────────────
  const handleBrowse = async () => {
    if (!conn || explorerSelection.kind === "none" || !entityName) return;

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    // argv format must match the Go worker's peekMessages parser.
    // count must be a string; include an empty startSequence to match expected arg positions.
    let argv: string[];
    if (explorerSelection.kind === "queue") {
      argv = ["queue", explorerSelection.queueName, String(peekCount), peekMode, ""];
    } else {
      argv = [
        "topic",
        explorerSelection.topicName,
        explorerSelection.subscriptionName,
        String(peekCount),
        peekMode,
        "",
      ];
    }

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: entityName,
      entityType,
      operation: "Browse",
      status: "running",
    });

    clearPeekResults();
    setSelectedMessage(null);
    clearGridFilters();
    setGridPage(1);
    setLastBrowseError(null);
    setBrowsing(true);

    try {
      const result = await invoke<PeekResult>("peek_messages", {
        args: {
          argv,
          connectionId: conn.id,
          runId,
        },
      });
      setPeekResults(result.messages, result.filename);
      updateEventLogEntry(runId, "success");
    } catch (err) {
      const msg = String(err);
      setLastBrowseError(msg);
      updateEventLogEntry(runId, "error", msg);
    } finally {
      setBrowsing(false);
    }
  };

  // ── Load More (append next batch, per-source sequence tracking) ───────────
  const handleLoadMore = async () => {
    if (!conn || explorerSelection.kind === "none" || !entityName) return;

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: entityName,
      entityType,
      operation: "Browse",
      status: "running",
    });

    setLastBrowseError(null);
    setLoadingMore(true);

    const buildArgv = (mode: "normal" | "dlq", startSeq: string): string[] => {
      if (explorerSelection.kind === "queue") {
        return ["queue", explorerSelection.queueName, String(peekCount), mode, startSeq];
      }
      return [
        "topic",
        explorerSelection.topicName,
        explorerSelection.subscriptionName,
        String(peekCount),
        mode,
        startSeq,
      ];
    };

    const invokeArgs = (argv: string[]) => ({
      argv,
      connectionId: conn.id,
      runId,
    });

    try {
      if (peekMode === "both") {
        // DLQ and normal queue have independent sequence number spaces — run separately.
        if (lastPeekNormalMaxSeqNum !== null) {
          const r = await invoke<PeekResult>("peek_messages", {
            args: invokeArgs(buildArgv("normal", String(lastPeekNormalMaxSeqNum + 1))),
          });
          appendPeekResults(r.messages, r.filename);
        }
        if (lastPeekDlqMaxSeqNum !== null) {
          const r = await invoke<PeekResult>("peek_messages", {
            args: invokeArgs(buildArgv("dlq", String(lastPeekDlqMaxSeqNum + 1))),
          });
          appendPeekResults(r.messages, r.filename);
        }
      } else {
        const startSeqNum = peekMode === "normal" ? lastPeekNormalMaxSeqNum : lastPeekDlqMaxSeqNum;
        if (startSeqNum === null) return;
        const r = await invoke<PeekResult>("peek_messages", {
          args: invokeArgs(buildArgv(peekMode, String(startSeqNum + 1))),
        });
        appendPeekResults(r.messages, r.filename);
      }
      updateEventLogEntry(runId, "success");
    } catch (err) {
      const msg = String(err);
      setLastBrowseError(msg);
      updateEventLogEntry(runId, "error", msg);
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Receive (destructive empty) ────────────────────────────────────────────
  const handleReceiveConfirm = async () => {
    if (!conn || explorerSelection.kind === "none" || !entityName) return;
    setConfirm(null);

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: displayEntity ?? entityName,
      entityType,
      operation: "Receive",
      status: "running",
    });

    const params = buildEmptyMessagesParams(explorerSelection, peekMode, conn.id);
    if (!params) return;
    const { exitCode, errorMessage } = await runOperation("empty_messages", params);
    updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
  };

  // ── Replay (DLQ → main) ────────────────────────────────────────────────────
  const handleReplayConfirm = async () => {
    if (!conn || explorerSelection.kind !== "queue") return;
    setConfirm(null);

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: displayEntity ?? explorerSelection.queueName,
      entityType,
      operation: "Replay",
      status: "running",
    });

    const params = buildReplayParams(explorerSelection, conn.id);
    if (!params) return;
    const { exitCode, errorMessage } = await runOperation("move_messages", params);
    updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
  };

  // ── Republish subscription DLQ → topic ────────────────────────────────────
  const handleRepublishConfirm = async () => {
    if (!conn || explorerSelection.kind !== "subscription") return;
    setConfirm(null);

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: `${displayEntity ?? `${explorerSelection.topicName}/${explorerSelection.subscriptionName}`} → ${explorerSelection.topicName}`,
      entityType,
      operation: "Republish",
      status: "running",
    });

    const params = buildRepublishSubscriptionDlqParams(explorerSelection, conn.id);
    if (!params) return;
    const { exitCode, errorMessage } = await runOperation("republish_subscription_dlq", params);
    updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
  };

  const loadMoreDisabled =
    !hasSelection ||
    busy ||
    (peekMode === "normal"
      ? lastPeekNormalMaxSeqNum === null
      : peekMode === "dlq"
        ? lastPeekDlqMaxSeqNum === null
        : lastPeekNormalMaxSeqNum === null && lastPeekDlqMaxSeqNum === null);

  const loadMoreTitle = (() => {
    if (peekMode === "normal") {
      return lastPeekNormalMaxSeqNum === null
        ? t("explorer.toolbar.noSeqAvailable")
        : t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: lastPeekNormalMaxSeqNum + 1 });
    }
    if (peekMode === "dlq") {
      return lastPeekDlqMaxSeqNum === null
        ? t("explorer.toolbar.noSeqAvailable")
        : t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: lastPeekDlqMaxSeqNum + 1 });
    }
    const parts: string[] = [];
    if (lastPeekNormalMaxSeqNum !== null)
      parts.push(t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: lastPeekNormalMaxSeqNum + 1 }));
    if (lastPeekDlqMaxSeqNum !== null)
      parts.push(t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: lastPeekDlqMaxSeqNum + 1 }));
    return parts.length === 0 ? t("explorer.toolbar.noSeqAvailable") : parts.join(" | ");
  })();

  return (
    <header className="relative shrink-0 h-12 flex items-center px-3 gap-3 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
      {/* Mode selector */}
      <ModeSelector value={peekMode} onChange={setPeekMode} />

      {/* Count input */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{t("explorer.toolbar.countLabel")}</span>
        <input
          type="number"
          value={peekCount}
          min={1}
          max={5000}
          onChange={(e) => setPeekCount(Math.max(1, Math.min(5000, Number(e.target.value))))}
          className="w-16 text-xs px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
        />
      </div>

      {/* Divider */}
      <div className="h-6 w-px bg-zinc-200 dark:bg-zinc-700" />

      {/* Action buttons */}
      <div className="flex items-center gap-1.5">
        <ToolbarButton
          label={t("explorer.toolbar.browse")}
          icon={
            browsing ? (
              <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <Icon name="eye" size={13} />
            )
          }
          onClick={handleBrowse}
          disabled={!hasSelection || busy}
          title={hasSelection ? t("explorer.toolbar.browseTitle") : t("explorer.toolbar.browseTitleDisabled")}
        />

        {peekMessages.length > 0 && (
          <ToolbarButton
            label={t("explorer.toolbar.loadMore")}
            icon={
              loadingMore ? (
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <Icon name="chevronDown" size={13} />
              )
            }
            onClick={handleLoadMore}
            disabled={loadMoreDisabled}
            title={loadMoreTitle}
            primary
          />
        )}

        <ToolbarButton
          label={t("explorer.toolbar.send")}
          icon={<Icon name="send" size={13} />}
          onClick={() => setIsSendModalOpen(!isSendModalOpen)}
          disabled={!hasSelection}
          title={hasSelection ? t("explorer.toolbar.sendTitle") : t("explorer.toolbar.sendTitleDisabled")}
        />

        <ToolbarButton
          label={t("explorer.toolbar.move")}
          icon={<Icon name="move" size={13} />}
          onClick={() => setIsMoveModalOpen(true)}
          disabled={!hasSelection || busy}
          title={
            !hasSelection
              ? t("explorer.toolbar.moveSelectFirst")
              : t("explorer.toolbar.moveTitle")
          }
        />

        <ToolbarButton
          label={t("explorer.toolbar.receive")}
          icon={<Icon name="box" size={13} />}
          onClick={() => setConfirm("receive")}
          disabled={!hasSelection || busy}
          title={
            !hasSelection
              ? t("explorer.toolbar.receiveSelectFirst")
              : t("explorer.toolbar.receiveTitle")
          }
          danger
        />

        <ToolbarButton
          label={t("explorer.toolbar.replay")}
          icon={<Icon name="move" size={13} />}
          onClick={() => setConfirm("replay")}
          disabled={!hasSelection || !canReplay || busy}
          title={
            !hasSelection
              ? t("explorer.toolbar.replaySelectFirst")
              : !canReplay
                ? t("explorer.toolbar.replayQueuesOnly")
                : t("explorer.toolbar.replayTitle")
          }
          warn
        />

        {canRepublish && (
          <ToolbarButton
            label={t("explorer.toolbar.republish")}
            icon={<Icon name="send" size={13} />}
            onClick={() => setConfirm("republish")}
            disabled={!hasSelection || !canRepublish || busy}
            title={
              !hasSelection
                ? t("explorer.toolbar.republishSelectFirst")
                : t("explorer.toolbar.republishTitle")
            }
            warn
          />
        )}

        <ToolbarButton
          label={t("explorer.toolbar.manageRules")}
          icon={<Icon name="settings" size={13} />}
          onClick={() => setIsSubscriptionRulesModalOpen(true)}
          disabled={!canManageRules || busy}
          title={
            !canManageRules
              ? t("explorer.toolbar.manageRulesSelectSubscription")
              : t("explorer.toolbar.manageRulesTitle")
          }
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Connection selector */}
      <div className="flex items-center gap-1.5">
        <ConnectionSelector />

        <button
          onClick={() => setIsSettingsModalOpen(true, "connections")}
          className="p-1.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          title={t("explorer.settingsModal.title")}
        >
          <Icon name="settings" size={14} />
        </button>

      </div>

      {/* Confirm modals */}
      {confirm === "receive" && (
        <ConfirmModal
          title={t("explorer.toolbar.receive")}
          message={t("explorer.toolbar.confirmReceive", { entity: displayEntity, mode: peekMode })}
          danger
          onConfirm={() => void handleReceiveConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "replay" && (
        <ConfirmModal
          title={t("explorer.toolbar.replay")}
          message={t("explorer.toolbar.confirmReplay", { entity: displayEntity })}
          onConfirm={() => void handleReplayConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "republish" && (
        <ConfirmModal
          title={t("explorer.toolbar.republish")}
          message={t("explorer.toolbar.confirmRepublish", {
            entity: displayEntity,
            topic: explorerSelection.kind === "subscription" ? explorerSelection.topicName : undefined,
          })}
          onConfirm={() => void handleRepublishConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </header>
  );
}
