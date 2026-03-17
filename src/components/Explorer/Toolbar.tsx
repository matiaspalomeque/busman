import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useConnections } from "../../hooks/useConnections";
import { useScript } from "../../hooks/useScript";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";
import type { PeekResult, QueueMode } from "../../types";

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

// ─── Confirm overlay ──────────────────────────────────────────────────────────

interface ConfirmBannerProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmBanner({ message, onConfirm, onCancel }: ConfirmBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="absolute top-full left-0 right-0 z-50 flex items-center gap-3 px-4 py-2.5 bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-700 text-xs">
      <span className="text-amber-800 dark:text-amber-200 flex-1">{message}</span>
      <button
        onClick={onCancel}
        className="px-2.5 py-1 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700"
      >
        {t("explorer.toolbar.cancel")}
      </button>
      <button
        onClick={onConfirm}
        className="px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700"
      >
        {t("explorer.toolbar.confirm")}
      </button>
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

// ─── Toolbar ──────────────────────────────────────────────────────────────────

export function Toolbar() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const {
    connections,
    explorerSelection,
    peekMessages,
    lastPeekNormalMaxSeqNum,
    lastPeekDlqMaxSeqNum,
    isRunning,
    isSendModalOpen,
    setIsSendModalOpen,
    setIsMoveModalOpen,
    setIsConnectionsModalOpen,
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
  const { setActive } = useConnections();
  const { runOperation, stop } = useScript();

  const [peekMode, setPeekMode] = useState<QueueMode>("dlq");
  const [peekCount, setPeekCount] = useState(100);
  const [browsing, setBrowsing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirm, setConfirm] = useState<"receive" | "replay" | null>(null);

  const hasSelection = explorerSelection.kind !== "none";
  const isQueue = explorerSelection.kind === "queue";
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
    if (!conn || !isQueue || !entityName) return;
    setConfirm(null);

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: entityName,
      entityType,
      operation: "Receive",
      status: "running",
    });

    const { exitCode, errorMessage } = await runOperation("empty_messages", {
      queueName: entityName,
      mode: peekMode,
      connectionId: conn.id,
    });
    updateEventLogEntry(runId, exitCode === 0 ? "success" : exitCode === 130 ? "stopped" : "error", errorMessage);
  };

  // ── Replay (DLQ → main) ────────────────────────────────────────────────────
  const handleReplayConfirm = async () => {
    if (!conn || !isQueue || !entityName) return;
    setConfirm(null);

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: entityName,
      entityType,
      operation: "Replay",
      status: "running",
    });

    const { exitCode, errorMessage } = await runOperation("move_messages", {
      sourceQueue: entityName,
      destQueue: entityName,
      mode: "dlq",
      connectionId: conn.id,
    });
    updateEventLogEntry(runId, exitCode === 0 ? "success" : exitCode === 130 ? "stopped" : "error", errorMessage);
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
          disabled={!hasSelection || !isQueue || busy}
          title={
            !hasSelection
              ? t("explorer.toolbar.moveSelectFirst")
              : !isQueue
                ? t("explorer.toolbar.moveQueuesOnly")
                : t("explorer.toolbar.moveTitle")
          }
        />

        <ToolbarButton
          label={t("explorer.toolbar.receive")}
          icon={<Icon name="box" size={13} />}
          onClick={() => setConfirm("receive")}
          disabled={!hasSelection || !isQueue || busy}
          title={
            !hasSelection
              ? t("explorer.toolbar.receiveSelectFirst")
              : !isQueue
                ? t("explorer.toolbar.receiveQueuesOnly")
                : t("explorer.toolbar.receiveTitle")
          }
          danger
        />

        <ToolbarButton
          label={t("explorer.toolbar.replay")}
          icon={<Icon name="move" size={13} />}
          onClick={() => setConfirm("replay")}
          disabled={!hasSelection || !isQueue || busy}
          title={
            !hasSelection
              ? t("explorer.toolbar.replaySelectFirst")
              : !isQueue
                ? t("explorer.toolbar.replayQueuesOnly")
                : t("explorer.toolbar.replayTitle")
          }
          warn
        />

        {isRunning && (
          <button
            onClick={() => void stop()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            <Icon name="close" size={13} />
            {t("explorer.toolbar.stop")}
          </button>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Connection selector */}
      <div className="flex items-center gap-1.5">
        {connections.length > 0 ? (
          <select
            value={conn?.id ?? ""}
            onChange={(e) => void setActive(e.target.value || null)}
            className="text-xs px-2 py-1.5 pr-6 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200 appearance-none select-custom-arrow max-w-48 truncate"
          >
            <option value="">{t("explorer.toolbar.selectConnection")}</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-zinc-400">{t("explorer.toolbar.noConnections")}</span>
        )}

        <button
          onClick={() => setIsConnectionsModalOpen(true)}
          className="p-1.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          title={t("explorer.toolbar.manageConnections")}
        >
          <Icon name="settings" size={14} />
        </button>

      </div>

      {/* Confirm banners (rendered below toolbar) */}
      {confirm === "receive" && (
        <ConfirmBanner
          message={t("explorer.toolbar.confirmReceive", { entity: entityName, mode: peekMode })}
          onConfirm={() => void handleReceiveConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "replay" && (
        <ConfirmBanner
          message={t("explorer.toolbar.confirmReplay", { entity: entityName })}
          onConfirm={() => void handleReplayConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </header>
  );
}
