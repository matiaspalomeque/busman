import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useScript } from "../../hooks/useScript";
import { extractNamespace } from "../../utils/connection";
import { exitCodeToStatus } from "../../utils/exitCode";
import {
  copyMessageId,
  copySequenceNumber,
  copyMessageBody,
  copyMessageJson,
  openResend,
  openMoveSingle,
} from "./messageActions";

type ConfirmAction = "delete" | "replay";

export function MessageContextMenu() {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const conn = useAppStore(selectActiveConnection);
  const {
    messageContextMenu,
    setMessageContextMenu,
    explorerSelection,
    isRunning,
    addEventLogEntry,
    updateEventLogEntry,
    removePeekedMessageBySeq,
  } = useAppStore();
  const store = useAppStore.getState;
  const { runOperation } = useScript();

  const close = () => {
    setConfirmAction(null);
    setMessageContextMenu(null);
  };

  const msg = messageContextMenu?.msg;
  const isDlq = msg ? msg._source.startsWith("Dead Letter") : false;

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

  const handleConfirm = () => {
    if (!conn || isRunning || !confirmAction || msg.sequenceNumber == null) return;

    const action = confirmAction;
    const targetMsg = msg;
    const namespace = extractNamespace(conn.connectionString);
    const runId = crypto.randomUUID();
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
      operation: action === "delete" ? "DeleteMessage" : "ReplayMessage",
      status: "running",
    });

    // Close the menu now so the toolbar Stop button becomes accessible.
    close();

    const params: Record<string, unknown> = {
      action,
      sequenceNumber: Number(targetMsg.sequenceNumber),
      isDlq: isDlq,
      connectionId: conn.id,
    };
    if (explorerSelection.kind === "queue") {
      params.queueName = explorerSelection.queueName;
      if (action === "replay") params.destQueue = explorerSelection.queueName;
    } else if (explorerSelection.kind === "subscription") {
      params.topicName = explorerSelection.topicName;
      params.subscriptionName = explorerSelection.subscriptionName;
      if (action === "replay") params.destTopic = explorerSelection.topicName;
    }

    void runOperation("single_message_action", params, { scope: "atomic" })
      .then(({ exitCode, errorMessage }) => {
        updateEventLogEntry(runId, exitCodeToStatus(exitCode), errorMessage);
        if (exitCode === 0) {
          removePeekedMessageBySeq(targetMsg.sequenceNumber);
        }
      })
      .catch(() => {
        updateEventLogEntry(runId, "error");
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
            disabled={isRunning}
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
      <MenuItem label={t("explorer.messageContext.move")} onClick={() => { close(); openMoveSingle(msg, store()); }} />
      {isDlq && (
        <MenuItem label={t("explorer.messageContext.replay")} onClick={() => setConfirmAction("replay")} />
      )}

      <Divider />

      <MenuItem
        label={t("explorer.messageContext.delete")}
        onClick={() => setConfirmAction("delete")}
        danger
      />
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={[
        "w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors",
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
