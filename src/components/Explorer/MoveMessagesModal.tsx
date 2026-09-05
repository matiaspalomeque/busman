import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useScript } from "../../hooks/useScript";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { Icon } from "../Common/Icon";
import { getDisplayEntity } from "./toolbarActions";
import { extractNamespace } from "../../utils/connection";
import { exitCodeToStatus } from "../../utils/exitCode";
import type { QueueMode } from "../../types";
import { addSingleMessageActionMetadata, isDeadLetterMessage, messageOperationKey } from "../../utils/messageOperation";
import { isCanonicalSequenceNumber } from "../../utils/sequenceNumber";

const MODES: QueueMode[] = ["normal", "dlq", "both"];

/** If a queue ends with _error (MassTransit pattern), suggest stripping the suffix. */
function suggestDestQueue(sourceQueue: string): string {
  if (sourceQueue.endsWith("_error")) {
    return sourceQueue.slice(0, -"_error".length);
  }
  return "";
}

export function MoveMessagesModal() {
  const { t } = useTranslation();
  // Capture the intent once. A background selection change must never retarget a move.
  const [context] = useState(() => {
    const state = useAppStore.getState();
    return { conn: selectActiveConnection(state), explorerSelection: state.explorerSelection,
      entities: state.entities, singleMessageMoveTarget: state.singleMessageMoveTarget,
      mode: state.peekMode, generation: state.connectionGeneration };
  });
  const { conn, explorerSelection, entities, singleMessageMoveTarget } = context;
  const generation = useAppStore((state) => state.connectionGeneration);
  const {
    isRunning,
    setIsMoveModalOpen,
    setSingleMessageMoveTarget,
    pendingMessageOperations,
    addEventLogEntry,
    updateEventLogEntry,
    startMessageOperation,
  } = useAppStore(useShallow((state) => ({
    isRunning: state.isRunning,
    setIsMoveModalOpen: state.setIsMoveModalOpen,
    setSingleMessageMoveTarget: state.setSingleMessageMoveTarget,
    pendingMessageOperations: state.pendingMessageOperations,
    addEventLogEntry: state.addEventLogEntry,
    updateEventLogEntry: state.updateEventLogEntry,
    startMessageOperation: state.startMessageOperation,
  })));

  const { runOperation } = useScript();

  const isSingleMessage = singleMessageMoveTarget != null;
  const isSingleMessageDlq = singleMessageMoveTarget ? isDeadLetterMessage(singleMessageMoveTarget) : false;
  const singleMessageKey = singleMessageMoveTarget ? messageOperationKey(singleMessageMoveTarget) : null;
  const singleMessagePending = singleMessageKey ? pendingMessageOperations[singleMessageKey] != null : false;
  const isSubscriptionSource = !isSingleMessage && explorerSelection.kind === "subscription";
  const initialSource = getDisplayEntity(explorerSelection) ?? "";

  const [sourceQueue, setSourceQueue] = useState(initialSource);
  const [destQueue, setDestQueue] = useState(() =>
    isSubscriptionSource ? "" : suggestDestQueue(initialSource),
  );
  const [mode, setMode] = useState<QueueMode>(context.mode);

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);

  // Update dest suggestion when source changes (only if dest is still empty or was auto-filled)
  const prevSourceRef = useRef(initialSource);
  useEffect(() => {
    const prev = prevSourceRef.current;
    const suggested = suggestDestQueue(prev);
    // Only auto-update dest if it still matches the previous suggestion
    if (destQueue === suggested || destQueue === "") {
      setDestQueue(suggestDestQueue(sourceQueue));
    }
    prevSourceRef.current = sourceQueue;
  }, [sourceQueue]);

  const close = () => {
    setIsMoveModalOpen(false);
    setSingleMessageMoveTarget(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  const sameQueueError =
    !isSubscriptionSource &&
    !isSingleMessage &&
    sourceQueue.trim() === destQueue.trim() &&
    (mode === "normal" || mode === "both");

  const canSubmit =
    !!conn &&
    generation === context.generation &&
    (isSingleMessage || sourceQueue.trim() !== "") &&
    (!isSingleMessage || isSingleMessageDlq) &&
    destQueue.trim() !== "" &&
    !sameQueueError &&
    !isRunning &&
    !singleMessagePending;

  const handleMove = () => {
    if (!conn || !canSubmit) return;

    const runId = crypto.randomUUID();
    const namespace = extractNamespace(conn.connectionString);

    const singleMessageSequenceNumber =
      isSingleMessage && singleMessageMoveTarget && isCanonicalSequenceNumber(singleMessageMoveTarget.sequenceNumber)
        ? singleMessageMoveTarget.sequenceNumber
        : null;
    if (isSingleMessage && singleMessageSequenceNumber === null) {
      return;
    }
    if (isSingleMessage && !isSingleMessageDlq) return;

    // Close immediately so the toolbar (and its stop button) becomes accessible.
    close();

    if (isSingleMessage && singleMessageMoveTarget && singleMessageKey) {
      const msg = singleMessageMoveTarget;
      const isDlq = isDeadLetterMessage(msg);
      const entityLabel = getDisplayEntity(explorerSelection) ?? sourceQueue.trim();

      addEventLogEntry({
        id: runId,
        time: new Date().toISOString(),
        namespace,
        entity: `${entityLabel}${msg.sequenceNumber != null ? ` #${msg.sequenceNumber}` : ""} → ${destQueue.trim()}`,
        entityType: explorerSelection.kind === "subscription" ? "Subscription" : "Queue",
        operation: "MoveMessage",
        status: "running",
      });
      startMessageOperation(singleMessageKey, {
        runId,
        operation: "MoveMessage",
        startedAt: new Date().toISOString(),
      });

      const params: Record<string, unknown> = {
        action: "move",
        sequenceNumber: singleMessageSequenceNumber,
        isDlq,
        destQueue: destQueue.trim(),
        connectionId: conn.id,
      };
      addSingleMessageActionMetadata(params, msg);
      if (explorerSelection.kind === "queue") {
        params.queueName = explorerSelection.queueName;
      } else if (explorerSelection.kind === "subscription") {
        params.topicName = explorerSelection.topicName;
        params.subscriptionName = explorerSelection.subscriptionName;
      }

      void runOperation("single_message_action", params, { scope: "atomic", runId })
        .then(({ exitCode, errorMessage, contextCurrent }) => {
          updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
          if (exitCode === 0 && contextCurrent !== false) {
            useAppStore.getState().removePeekedMessageByKey(singleMessageKey);
          }
        })
        .catch((error) => {
          updateEventLogEntry(runId, "error", String(error));
        })
        .finally(() => {
          useAppStore.getState().finishMessageOperation(singleMessageKey, runId);
        });
      return;
    }

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: `${sourceQueue.trim()} → ${destQueue.trim()}`,
      entityType: isSubscriptionSource ? "Subscription" : "Queue",
      operation: "Move",
      status: "running",
    });

    const params: Record<string, unknown> = {
      destQueue: destQueue.trim(),
      mode,
      connectionId: conn.id,
    };

    if (isSubscriptionSource && explorerSelection.kind === "subscription") {
      params.topicName = explorerSelection.topicName;
      params.subscriptionName = explorerSelection.subscriptionName;
    } else {
      params.sourceQueue = sourceQueue.trim();
    }

    void runOperation("move_messages", params, { runId })
      .then(({ exitCode, errorMessage }) => {
        updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
      })
      .catch((error) => {
        updateEventLogEntry(runId, "error", String(error));
      });
  };

  const queues = entities?.queues ?? [];

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) close();
      }}
      onKeyDown={handleKeyDown}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="move-dialog-title" className="bg-white dark:bg-zinc-900 rounded-lg shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md max-h-[90vh] overflow-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-700">
          <h2 id="move-dialog-title" className="text-sm font-semibold text-azure-dark dark:text-azure-light flex items-center gap-2">
            <Icon name="move" size={14} className="text-azure-primary" />
            {isSingleMessage ? t("explorer.messageContext.moveMessageTitle") : t("explorer.moveModal.title")}
          </h2>
          <button
            aria-label={t("explorer.moveModal.close")}
            onClick={close}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-xs break-words text-zinc-600 dark:text-zinc-300">
            {conn?.environment ? `${conn.environment} · ` : ""}{conn?.name} · {conn ? extractNamespace(conn.connectionString) : ""}
          </p>
          {generation !== context.generation && <p role="alert" className="text-xs text-red-600">{t("explorer.moveModal.contextChanged")}</p>}
          {/* Source */}
          <div className="flex flex-col gap-1">
            <label htmlFor="move-source" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              {t(isSubscriptionSource ? "explorer.moveModal.sourceEntity" : "explorer.moveModal.sourceQueue")} <span className="text-red-500">*</span>
            </label>
            {isSingleMessage && singleMessageMoveTarget ? (
              <div className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 opacity-70">
                {sourceQueue}{singleMessageMoveTarget.sequenceNumber != null ? ` #${singleMessageMoveTarget.sequenceNumber}` : ""}
              </div>
            ) : (
              <>
                <input
                  id="move-source"
                  list={isSubscriptionSource ? undefined : "move-source-queues"}
                  type="text"
                  value={sourceQueue}
                  onChange={(e) => setSourceQueue(e.target.value)}
                  readOnly={isSubscriptionSource}
                  placeholder={t("explorer.moveModal.sourcePlaceholder")}
                  className={[
                    "text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200",
                    isSubscriptionSource ? "opacity-70 cursor-not-allowed" : "",
                  ].join(" ")}
                />
                {!isSubscriptionSource && queues.length > 0 && (
                  <datalist id="move-source-queues">
                    {queues.map((q) => (
                      <option key={q} value={q} />
                    ))}
                  </datalist>
                )}
              </>
            )}
          </div>

          {/* Destination Queue */}
          <div className="flex flex-col gap-1">
            <label htmlFor="move-destination" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              {t("explorer.moveModal.destQueue")} <span className="text-red-500">*</span>
            </label>
            <input
              id="move-destination"
              data-dialog-initial-focus
              list="move-dest-queues"
              type="text"
              value={destQueue}
              onChange={(e) => setDestQueue(e.target.value)}
              placeholder={t("explorer.moveModal.destPlaceholder")}
              className="text-xs px-2.5 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
            />
            {queues.length > 0 && (
              <datalist id="move-dest-queues">
                {queues.map((q) => (
                  <option key={q} value={q} />
                ))}
              </datalist>
            )}
            <div className="min-h-4" aria-live="assertive">
              {sameQueueError && (
                <p role="alert" className="text-[10px] text-red-500">{t("explorer.moveModal.errorSameQueue")}</p>
              )}
            </div>
          </div>

          {/* Mode — hidden in single-message mode */}
          {!isSingleMessage && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                {t("explorer.moveModal.mode")}
              </label>
              <div className="flex items-center border border-zinc-300 dark:border-zinc-600 rounded overflow-hidden w-fit">
                {MODES.map((m) => (
                  <button
                    key={m}
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={[
                      "px-3 py-1.5 text-xs transition-colors",
                      mode === m
                        ? "bg-azure-primary text-white"
                        : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700",
                    ].join(" ")}
                  >
                    {t(`modeSelector.${m}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Warning / note */}
          {!isSingleMessage && <p className="text-xs font-medium break-words text-zinc-700 dark:text-zinc-200" aria-live="polite">
            {t("explorer.moveModal.scopeSummary", { mode: t(`modeSelector.${mode}`), source: sourceQueue, destination: destQueue || "…" })}
          </p>}
          <div className="flex items-start gap-2 px-3 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
            <span className="text-amber-500 mt-0.5 shrink-0">⚠</span>
            <p className="text-[11px] text-amber-800 dark:text-amber-300">
              {isSingleMessage
                ? t("explorer.messageContext.moveWarning")
                : t("explorer.moveModal.warning")}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-200 dark:border-zinc-700">
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
          >
            {t("explorer.moveModal.close")}
          </button>
          <button
            onClick={handleMove}
            disabled={!canSubmit}
            className="text-xs px-4 py-1.5 rounded bg-azure-primary text-white hover:bg-azure-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("explorer.moveModal.move")}
          </button>
        </div>
      </div>
    </div>
  );
}
