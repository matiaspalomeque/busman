import { useShallow } from "zustand/react/shallow";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useScript } from "../../hooks/useScript";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";
import { exitCodeToStatus } from "../../utils/exitCode";
import { incrementSequenceNumber } from "../../utils/sequenceNumber";
import { PeekResultSchema, safeInvoke } from "../../schemas/ipc";
import type { ExplorerSelection } from "../../types";
import {
  buildEmptyMessagesParams,
  buildReplayParams,
  buildRepublishSubscriptionDlqParams,
  canManageRulesSelection,
  canReplaySelection,
  canRepublishSelection,
  getDisplayEntity,
} from "./toolbarActions";
import { ConfirmModal, ConnectionSelector, ModeSelector, MoreActionsDropdown, ToolbarButton } from "./ToolbarControls";

function selectionKey(selection: ExplorerSelection): string {
  if (selection.kind === "queue") return `queue:${selection.queueName}`;
  if (selection.kind === "subscription") {
    return `subscription:${selection.topicName}/${selection.subscriptionName}`;
  }
  return "none";
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

export function Toolbar() {
  const { t } = useTranslation();
  const countInputId = useId();
  const conn = useAppStore(selectActiveConnection);
  const {
    explorerSelection,
    peekMode,
    setPeekMode,
    peekMessages,
    lastPeekNormalMaxSeqNum,
    lastPeekDlqMaxSeqNum,
    isRunning,
    setIsSendModalOpen,
    setIsMoveModalOpen,
    setIsSettingsModalOpen,
    setIsSubscriptionRulesModalOpen,
    isInsightsPanelOpen,
    setIsInsightsPanelOpen,
    clearPeekResults,
    setPeekResults,
    appendPeekResults,
    setSelectedMessage,
    clearGridFilters,
    setGridPage,
    addEventLogEntry,
    updateEventLogEntry,
    setLastBrowseError,
  } = useAppStore(useShallow((state) => ({
    explorerSelection: state.explorerSelection,
    peekMode: state.peekMode,
    setPeekMode: state.setPeekMode,
    peekMessages: state.peekMessages,
    lastPeekNormalMaxSeqNum: state.lastPeekNormalMaxSeqNum,
    lastPeekDlqMaxSeqNum: state.lastPeekDlqMaxSeqNum,
    isRunning: state.isRunning,
    setIsSendModalOpen: state.setIsSendModalOpen,
    setIsMoveModalOpen: state.setIsMoveModalOpen,
    setIsSettingsModalOpen: state.setIsSettingsModalOpen,
    setIsSubscriptionRulesModalOpen: state.setIsSubscriptionRulesModalOpen,
    isInsightsPanelOpen: state.isInsightsPanelOpen,
    setIsInsightsPanelOpen: state.setIsInsightsPanelOpen,
    clearPeekResults: state.clearPeekResults,
    setPeekResults: state.setPeekResults,
    appendPeekResults: state.appendPeekResults,
    setSelectedMessage: state.setSelectedMessage,
    clearGridFilters: state.clearGridFilters,
    setGridPage: state.setGridPage,
    addEventLogEntry: state.addEventLogEntry,
    updateEventLogEntry: state.updateEventLogEntry,
    setLastBrowseError: state.setLastBrowseError,
  })));
  const { runOperation } = useScript();
  const atomicOperationCount = useAppStore((state) => Object.values(state.activeOperationRuns).filter((run) => run.scope === "atomic").length);

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

  const busy = browsing || loadingMore || isRunning || atomicOperationCount > 0;

  // ── Browse / Peek ──────────────────────────────────────────────────────────
  const handleBrowse = async () => {
    if (!conn || explorerSelection.kind === "none" || !entityName) return;

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);
    const requestConnId = conn.id;
    const requestGeneration = useAppStore.getState().connectionGeneration;
    const requestSelectionKey = selectionKey(explorerSelection);
    const isCurrentRequest = () => {
      const state = useAppStore.getState();
      return state.connectionGeneration === requestGeneration && state.activeConnectionId === requestConnId && selectionKey(state.explorerSelection) === requestSelectionKey;
    };

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
      const result = await safeInvoke("peek_messages", PeekResultSchema, {
        args: {
          argv,
          connectionId: requestConnId,
          runId,
        },
      });
      if (!isCurrentRequest()) {
        updateEventLogEntry(runId, "stopped", "Browse result ignored because selection changed");
        return;
      }
      setPeekResults(result.messages);
      updateEventLogEntry(runId, "success");
    } catch (err) {
      const msg = String(err);
      if (isCurrentRequest()) setLastBrowseError(msg);
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
    const requestConnId = conn.id;
    const requestGeneration = useAppStore.getState().connectionGeneration;
    const requestSelectionKey = selectionKey(explorerSelection);
    const isCurrentRequest = () => {
      const state = useAppStore.getState();
      return state.connectionGeneration === requestGeneration && state.activeConnectionId === requestConnId && selectionKey(state.explorerSelection) === requestSelectionKey;
    };

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
      connectionId: requestConnId,
      runId,
    });

    try {
      if (peekMode === "both") {
        // DLQ and normal queue have independent sequence number spaces — run separately.
        let requestedSource = false;
        const normalStart =
          lastPeekNormalMaxSeqNum === null ? "" : incrementSequenceNumber(lastPeekNormalMaxSeqNum);
        if (normalStart !== null) {
          requestedSource = true;
          const normalResult = await safeInvoke("peek_messages", PeekResultSchema, {
            args: invokeArgs(buildArgv("normal", normalStart)),
          });
          if (!isCurrentRequest()) {
            updateEventLogEntry(runId, "stopped", "Browse result ignored because selection changed");
            return;
          }
          appendPeekResults(normalResult.messages);
        }

        const dlqStart = lastPeekDlqMaxSeqNum === null ? "" : incrementSequenceNumber(lastPeekDlqMaxSeqNum);
        if (dlqStart !== null) {
          requestedSource = true;
          const dlqResult = await safeInvoke("peek_messages", PeekResultSchema, {
            args: invokeArgs(buildArgv("dlq", dlqStart)),
          });
          if (!isCurrentRequest()) {
            updateEventLogEntry(runId, "stopped", "Browse result ignored because selection changed");
            return;
          }
          appendPeekResults(dlqResult.messages);
        }

        if (!requestedSource) {
          const message = "Cannot load more: both sequence cursors are at the signed 64-bit maximum.";
          setLastBrowseError(message);
          updateEventLogEntry(runId, "stopped", message);
          return;
        }
      } else {
        const startSeqNum = peekMode === "normal" ? lastPeekNormalMaxSeqNum : lastPeekDlqMaxSeqNum;
        if (startSeqNum === null) return;
        const nextStartSeqNum = incrementSequenceNumber(startSeqNum);
        if (nextStartSeqNum === null) {
          const message = "Cannot load more: the sequence cursor is at the signed 64-bit maximum.";
          setLastBrowseError(message);
          updateEventLogEntry(runId, "stopped", message);
          return;
        }
        const r = await safeInvoke("peek_messages", PeekResultSchema, {
          args: invokeArgs(buildArgv(peekMode, nextStartSeqNum)),
        });
        if (!isCurrentRequest()) {
          updateEventLogEntry(runId, "stopped", "Browse result ignored because selection changed");
          return;
        }
        appendPeekResults(r.messages);
      }
      updateEventLogEntry(runId, "success");
    } catch (err) {
      const msg = String(err);
      if (isCurrentRequest()) setLastBrowseError(msg);
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
    try {
      const { exitCode, errorMessage } = await runOperation("empty_messages", params, { runId });
      updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
    } catch (error) {
      updateEventLogEntry(runId, "error", String(error));
    }
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
    try {
      const { exitCode, errorMessage } = await runOperation("move_messages", params, { runId });
      updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
    } catch (error) {
      updateEventLogEntry(runId, "error", String(error));
    }
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
    try {
      const { exitCode, errorMessage } = await runOperation("republish_subscription_dlq", params, { runId });
      updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
    } catch (error) {
      updateEventLogEntry(runId, "error", String(error));
    }
  };

  const nextNormalSequenceNumber =
    lastPeekNormalMaxSeqNum === null ? null : incrementSequenceNumber(lastPeekNormalMaxSeqNum);
  const nextDlqSequenceNumber =
    lastPeekDlqMaxSeqNum === null ? null : incrementSequenceNumber(lastPeekDlqMaxSeqNum);

  const messageBudgetReached = useAppStore((state) => state.messageBudgetReached);
  const loadMoreDisabled = messageBudgetReached ||
    !hasSelection ||
    busy ||
    (peekMode === "normal"
      ? nextNormalSequenceNumber === null
      : peekMode === "dlq"
        ? nextDlqSequenceNumber === null
        : (lastPeekNormalMaxSeqNum === null && lastPeekDlqMaxSeqNum === null) ||
          (lastPeekNormalMaxSeqNum !== null && nextNormalSequenceNumber === null &&
            lastPeekDlqMaxSeqNum !== null && nextDlqSequenceNumber === null));

  const loadMoreTitle = (() => {
    if (peekMode === "normal") {
      return nextNormalSequenceNumber === null
        ? t("explorer.toolbar.noSeqAvailable")
        : t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: nextNormalSequenceNumber });
    }
    if (peekMode === "dlq") {
      return nextDlqSequenceNumber === null
        ? t("explorer.toolbar.noSeqAvailable")
        : t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: nextDlqSequenceNumber });
    }
    const parts: string[] = [];
    if (nextNormalSequenceNumber !== null)
      parts.push(t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: nextNormalSequenceNumber }));
    if (nextDlqSequenceNumber !== null)
      parts.push(t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: nextDlqSequenceNumber }));
    return parts.length === 0 ? t("explorer.toolbar.noSeqAvailable") : parts.join(" | ");
  })();

  return (
    <header className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900">
      {hasSelection && (
        <>
          <ModeSelector value={peekMode} onChange={setPeekMode} />
          <label htmlFor={countInputId} className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
            {t("explorer.toolbar.countLabel")}
            <input
              id={countInputId}
              type="number"
              value={peekCount}
              min={1}
              max={5000}
              onChange={(e) => setPeekCount(Math.max(1, Math.min(5000, Math.trunc(Number(e.target.value)) || 1)))}
              className="w-16 rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-600 dark:text-zinc-200"
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <ToolbarButton
              label={t("explorer.toolbar.browse")}
              icon={<Icon name={browsing ? "loader" : "eye"} size={14} className={browsing ? "animate-spin" : undefined} />}
              primary
              onClick={handleBrowse}
              disabled={busy}
              title={t("explorer.toolbar.browseTitle")}
            />
            {peekMessages.length > 0 && (
              <>
                <ToolbarButton
                  label={t("explorer.toolbar.loadMore")}
                  icon={<Icon name={loadingMore ? "loader" : "chevronDown"} size={14} className={loadingMore ? "animate-spin" : undefined} />}
                  onClick={handleLoadMore}
                  disabled={loadMoreDisabled}
                  title={loadMoreTitle}
                />
                <ToolbarButton
                  label={t("insights.toggle")}
                  icon={<Icon name="chartBar" size={14} />}
                  onClick={() => setIsInsightsPanelOpen(!isInsightsPanelOpen)}
                  title={t("insights.toggleTitle")}
                  active={isInsightsPanelOpen}
                />
              </>
            )}
            <ToolbarButton
              label={t("explorer.toolbar.send")}
              icon={<Icon name="send" size={14} />}
              onClick={() => setIsSendModalOpen(true)}
              disabled={busy}
              title={t("explorer.toolbar.sendTitle")}
            />
            <MoreActionsDropdown
              onMove={() => setIsMoveModalOpen(true)}
              onReceive={() => setConfirm("receive")}
              onReplay={() => setConfirm("replay")}
              onRepublish={() => setConfirm("republish")}
              onManageRules={() => setIsSubscriptionRulesModalOpen(true)}
              disabled={busy}
              canReplay={canReplay}
              canRepublish={canRepublish}
              canManageRules={canManageRules}
            />
          </div>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        <ConnectionSelector />
        <button type="button" onClick={() => setIsSettingsModalOpen(true, "connections")}
          aria-label={t("explorer.settingsModal.title")} title={t("explorer.settingsModal.title")}
          className="rounded border border-zinc-300 p-2 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-700">
          <Icon name="settings" size={15} />
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
