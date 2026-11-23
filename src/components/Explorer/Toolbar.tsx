import { useShallow } from "zustand/react/shallow";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { MAX_LOADED_BYTES, MAX_LOADED_MESSAGES } from "../../store/messageSlice";
import { useScript } from "../../hooks/useScript";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";
import { exitCodeToStatus } from "../../utils/exitCode";
import { incrementSequenceNumber } from "../../utils/sequenceNumber";
import { PeekResultSchema, safeInvoke } from "../../schemas/ipc";
import type { PeekSource } from "../../types";
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
    truncatedPeekSources,
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
    truncatedPeekSources: state.truncatedPeekSources,
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

  // A shared frame reads Normal first. Give the last interrupted source first access
  // to the remaining grid budget, always using that source's own sequence cursor.
  const priority = truncatedPeekSources[truncatedPeekSources.length - 1];
  const bothSources: PeekSource[] = priority === "dlq" ? ["dlq", "normal"] : ["normal", "dlq"];
  const sources = peekMode === "both" ? bothSources : [peekMode];
  const hasCursor = lastPeekNormalMaxSeqNum !== null || lastPeekDlqMaxSeqNum !== null;
  const continuation = sources.flatMap((source) => {
    const cursor = source === "normal" ? lastPeekNormalMaxSeqNum : lastPeekDlqMaxSeqNum;
    if (cursor === null) {
      return truncatedPeekSources.includes(source) || (peekMode === "both" && hasCursor) ? [{ source, start: "" }] : [];
    }
    const start = incrementSequenceNumber(cursor);
    return start === null ? [] : [{ source, start }];
  });

  // ── Browse / Peek ──────────────────────────────────────────────────────────
  const isCurrentSelection = (generation: number) => {
    const state = useAppStore.getState();
    // Returning to the same entity starts a new selection with fresh cursors.
    return state.explorerSelection === explorerSelection
      && state.activeConnectionId === conn?.id
      && state.connectionGeneration === generation;
  };

  const handleBrowse = async () => {
    if (!conn || explorerSelection.kind === "none" || !entityName) return;

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);
    const requestConnId = conn.id;
    const requestGeneration = useAppStore.getState().connectionGeneration;

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
      if (!isCurrentSelection(requestGeneration)) {
        updateEventLogEntry(runId, "stopped", "Browse result ignored because selection changed");
        return;
      }
      setPeekResults(result.messages, result.truncatedSources);
      updateEventLogEntry(runId, "success");
    } catch (err) {
      const msg = String(err);
      if (isCurrentSelection(requestGeneration)) setLastBrowseError(msg);
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
    const canAppend = () => isCurrentSelection(requestGeneration) && useAppStore.getState().hasBrowsed;

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

    const sourceErrors: string[] = [];
    try {
      for (const { source, start } of continuation) {
        const result = await safeInvoke("peek_messages", PeekResultSchema, {
          args: invokeArgs(buildArgv(source, start)),
        }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
        if (!canAppend()) {
          updateEventLogEntry(runId, "stopped", "Browse result ignored because the loaded view changed");
          return;
        }
        if ("error" in result) {
          const detail = peekMode === "both" ? `${t(`modeSelector.${source}`)}: ${result.error}` : result.error;
          sourceErrors.push(detail);
          setLastBrowseError(sourceErrors.join("\n"));
          // Native cancellation stops the whole run. Otherwise the other source still has its own cursor.
          if (result.error === "Operation cancelled.") break;
          continue;
        }
        appendPeekResults(result.messages, source, result.truncatedSources);
        const loaded = useAppStore.getState();
        // A record can be too large for the remaining room while the other source still fits.
        if (loaded.loadedMessageBytes >= MAX_LOADED_BYTES || loaded.peekMessages.length >= MAX_LOADED_MESSAGES) break;
      }
      const error = sourceErrors.length ? sourceErrors.join("\n") : undefined;
      updateEventLogEntry(runId, error === undefined ? "success" : "error", error);
    } catch (err) {
      const msg = [...sourceErrors, String(err)].join("\n");
      if (canAppend()) setLastBrowseError(msg);
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

  const messageBudgetReached = useAppStore((state) => state.messageBudgetReached);
  const loadMoreDisabled = messageBudgetReached || !hasSelection || busy || continuation.length === 0;
  const interrupted = truncatedPeekSources.filter((source) => peekMode === "both" || peekMode === source);
  const cursorTitles = continuation.filter(({ start }) => start !== "").map(({ start }) =>
    t("explorer.toolbar.loadMoreFromSeq", { count: peekCount, seq: start }));
  const loadMoreTitle = interrupted.length > 0
    ? t("explorer.grid.partialPage", { sources: interrupted.map((source) => t(`modeSelector.${source}`)).join(", ") })
    : cursorTitles.join(" | ") || t("explorer.toolbar.noSeqAvailable");

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
