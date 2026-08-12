import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useScript } from "../../hooks/useScript";
import { extractNamespace } from "../../utils/connection";
import { exitCodeToStatus } from "../../utils/exitCode";
import { isCanonicalSequenceNumber } from "../../utils/sequenceNumber";
import {
  copyMessageId,
  copySequenceNumber,
  copyMessageBody,
  copyMessageJson,
  openResend,
  openMoveSingle,
} from "./messageActions";
import {
  addSingleMessageActionMetadata,
  isDeadLetterMessage,
  messageOperationKey,
  type MessageOperation,
} from "../../utils/messageOperation";
import { SessionStateModal, type SessionStateTarget } from "./SessionStateModal";

type ConfirmAction = "delete" | "replay";

export function MessageContextMenu() {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [managingSessionState, setManagingSessionState] = useState(false);

  const conn = useAppStore(selectActiveConnection);
  const {
    messageContextMenu,
    setMessageContextMenu,
    explorerSelection,
    isRunning,
    pendingMessageOperations,
    addEventLogEntry,
    updateEventLogEntry,
    startMessageOperation,
    finishMessageOperation,
    removePeekedMessageByKey,
  } = useAppStore();
  const store = useAppStore.getState;
  const { runOperation } = useScript();

  const close = () => {
    setConfirmAction(null);
    setManagingSessionState(false);
    setMessageContextMenu(null);
  };

  const msg = messageContextMenu?.msg;
  const isDlq = msg ? isDeadLetterMessage(msg) : false;

  // Dismiss on click outside
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, []);

  // Escape: back to main menu from confirm state, otherwise close
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (confirmAction) setConfirmAction(null);
        else close();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [confirmAction]);

  if (!messageContextMenu || !msg) return null;

  const MENU_W = 220;
  const MENU_H = 300;
  const x = Math.min(messageContextMenu.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(messageContextMenu.y, window.innerHeight - MENU_H - 8);

  const seqLabel = msg.sequenceNumber != null ? ` #${msg.sequenceNumber}` : "";
  const msgKey = messageOperationKey(msg);
  const isPending = msgKey ? pendingMessageOperations[msgKey] != null : false;

  if (
    managingSessionState &&
    conn &&
    msg.sessionId != null &&
    msg.sessionId.trim() !== "" &&
    explorerSelection.kind !== "none"
  ) {
    const target: SessionStateTarget =
      explorerSelection.kind === "queue"
        ? {
            connectionId: conn.id,
            queueName: explorerSelection.queueName,
            sessionId: msg.sessionId,
          }
        : {
            connectionId: conn.id,
            topicName: explorerSelection.topicName,
            subscriptionName: explorerSelection.subscriptionName,
            sessionId: msg.sessionId,
          };
    return <SessionStateModal target={target} onClose={close} />;
  }

  const handleConfirm = () => {
    if (!conn || isRunning || isPending || !confirmAction || !isCanonicalSequenceNumber(msg.sequenceNumber) || !msgKey) return;

    const action = confirmAction;
    const targetMsg = msg;
    const targetKey = msgKey;
    const namespace = extractNamespace(conn.connectionString);
    const runId = crypto.randomUUID();
    const operation: MessageOperation = action === "delete" ? "DeleteMessage" : "ReplayMessage";
    const entityLabel =
      explorerSelection.kind === "queue"
        ? explorerSelection.queueName
        : explorerSelection.kind === "subscription"
          ? `${explorerSelection.topicName}/${explorerSelection.subscriptionName}`
          : "unknown";

    addEventLogEntry({
      id: runId,
      time: new Date().toISOString(),
      namespace,
      entity: `${entityLabel}${seqLabel}`,
      entityType: explorerSelection.kind === "subscription" ? "Subscription" : "Queue",
      operation,
      status: "running",
    });
    startMessageOperation(targetKey, {
      runId,
      operation,
      startedAt: new Date().toISOString(),
    });

    close();

    const params: Record<string, unknown> = {
      action,
      sequenceNumber: targetMsg.sequenceNumber,
      isDlq: isDlq,
      connectionId: conn.id,
    };
    addSingleMessageActionMetadata(params, targetMsg);
    if (explorerSelection.kind === "queue") {
      params.queueName = explorerSelection.queueName;
      if (action === "replay") params.destQueue = explorerSelection.queueName;
    } else if (explorerSelection.kind === "subscription") {
      params.topicName = explorerSelection.topicName;
      params.subscriptionName = explorerSelection.subscriptionName;
      if (action === "replay") params.destTopic = explorerSelection.topicName;
    }

    void runOperation("single_message_action", params, { scope: "atomic", runId })
      .then(({ exitCode, errorMessage }) => {
        updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
        if (exitCode === 0) {
          removePeekedMessageByKey(targetKey);
        }
      })
      .catch(() => {
        updateEventLogEntry(runId, "error");
      })
      .finally(() => {
        finishMessageOperation(targetKey);
      });
  };

  if (confirmAction) {
    const isDelete = confirmAction === "delete";
    return (
      <div
        ref={menuRef}
        className="fixed z-[200] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-xl text-xs"
        style={{ left: x, top: y, width: MENU_W }}
      >
        <div className="px-3 pt-3 pb-2">
          <p className={[
            "text-xs font-medium mb-0.5",
            isDelete ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400",
          ].join(" ")}>
            {isDelete
              ? t("explorer.messageContext.deleteConfirmTitle", { seq: seqLabel })
              : t("explorer.messageContext.replayConfirmTitle", { seq: seqLabel })}
          </p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
            {isDelete
              ? t("explorer.messageContext.deleteConfirmBody")
              : t("explorer.messageContext.replayConfirmBody")}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-3 pb-3">
          <button
            onClick={() => setConfirmAction(null)}
            className="px-2.5 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-[11px]"
          >
            {t("explorer.messageContext.cancel")}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isRunning || isPending}
            className={[
              "px-2.5 py-1 rounded text-white text-[11px] disabled:opacity-40 disabled:cursor-not-allowed",
              isDelete ? "bg-red-600 hover:bg-red-700" : "bg-amber-500 hover:bg-amber-600",
            ].join(" ")}
          >
            {isDelete
              ? t("explorer.messageContext.deleteConfirm")
              : t("explorer.messageContext.replayConfirm")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[200] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-xl py-1 text-xs"
      style={{ left: x, top: y, width: MENU_W }}
    >
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {t("explorer.messageContext.copySection")}
      </div>
      <MenuItem label={t("explorer.messageContext.copyMessageId")} onClick={() => { close(); copyMessageId(msg); }} />
      <MenuItem label={t("explorer.messageContext.copySequenceNumber")} onClick={() => { close(); copySequenceNumber(msg); }} />
      <MenuItem label={t("explorer.messageContext.copyBody")} onClick={() => { close(); copyMessageBody(msg); }} />
      <MenuItem label={t("explorer.messageContext.copyJson")} onClick={() => { close(); copyMessageJson(msg); }} />

      <Divider />

      <MenuItem label={t("explorer.messageContext.resend")} onClick={() => { close(); openResend(msg, store()); }} />
      {msg.sessionId != null && msg.sessionId.trim() !== "" && explorerSelection.kind !== "none" && (
        <MenuItem
          label={t("explorer.messageContext.manageSessionState")}
          onClick={() => setManagingSessionState(true)}
        />
      )}
      {isDlq && (
        <>
          <MenuItem label={t("explorer.messageContext.move")} onClick={() => { close(); openMoveSingle(msg, store()); }} disabled={isPending} />
          <MenuItem label={t("explorer.messageContext.replay")} onClick={() => setConfirmAction("replay")} disabled={isPending} />

          <Divider />

          <MenuItem
            label={t("explorer.messageContext.delete")}
            onClick={() => setConfirmAction("delete")}
            danger
            disabled={isPending}
          />
        </>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={[
        "w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        danger ? "text-red-600 dark:text-red-400" : "text-zinc-700 dark:text-zinc-200",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />;
}
