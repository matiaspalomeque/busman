import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SessionStateResultSchema, safeInvoke } from "../../schemas/ipc";
import {
  MAX_SESSION_STATE_BYTES,
  sessionStateBase64ByteLength,
} from "../../utils/sessionState";
import { Icon } from "../Common/Icon";

export interface SessionStateTarget {
  connectionId: string;
  sessionId: string;
  queueName?: string;
  topicName?: string;
  subscriptionName?: string;
}

interface SessionStateModalProps {
  target: SessionStateTarget;
  onClose: () => void;
}

type Confirmation = "set" | "clear" | null;

export function SessionStateModal({ target, onClose }: SessionStateModalProps) {
  const { t } = useTranslation();
  const [stateBase64, setStateBase64] = useState("");
  const [hasState, setHasState] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const parentEntity = target.queueName ?? `${target.topicName}/${target.subscriptionName}`;
  const targetArgs = {
    connectionId: target.connectionId,
    queueName: target.queueName,
    topicName: target.topicName,
    subscriptionName: target.subscriptionName,
    sessionId: target.sessionId,
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await safeInvoke(
          "get_session_state",
          SessionStateResultSchema,
          { args: targetArgs },
        );
        if (!active) return;
        setStateBase64(result.stateBase64);
        setHasState(result.hasState);
        setLoaded(true);
      } catch (loadError) {
        if (!active) return;
        setError(t("explorer.sessionState.loadFailed", { error: String(loadError) }));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
    // Target identity is fixed for the lifetime of this modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byteLength = sessionStateBase64ByteLength(stateBase64);

  const requestSet = () => {
    if (byteLength === null) {
      setError(
        t("explorer.sessionState.invalidBase64", { max: MAX_SESSION_STATE_BYTES }),
      );
      return;
    }
    setError(null);
    setConfirmation("set");
  };

  const confirmMutation = async () => {
    if (!confirmation) return;
    setSaving(true);
    setError(null);
    try {
      const command = confirmation === "set" ? "set_session_state" : "clear_session_state";
      const args = confirmation === "set" ? { ...targetArgs, stateBase64 } : targetArgs;
      const result = await safeInvoke(command, SessionStateResultSchema, { args });
      setStateBase64(result.stateBase64);
      setHasState(result.hasState);
      setLoaded(true);
      setConfirmation(null);
    } catch (mutationError) {
      const key = confirmation === "set" ? "setFailed" : "clearFailed";
      setError(t(`explorer.sessionState.${key}`, { error: String(mutationError) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-state-title"
        className="mx-4 w-full max-w-xl rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-700">
          <h2 id="session-state-title" className="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            <Icon name="settings" size={15} className="text-azure-primary" />
            {t("explorer.sessionState.title")}
          </h2>
          <button type="button" onClick={onClose} aria-label={t("explorer.sessionState.close")} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-zinc-500 dark:text-zinc-400">{t("explorer.sessionState.parentEntity")}</dt>
            <dd className="selectable font-mono text-zinc-700 dark:text-zinc-200">{parentEntity}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">{t("explorer.sessionState.sessionId")}</dt>
            <dd className="selectable break-all font-mono text-zinc-700 dark:text-zinc-200">{target.sessionId}</dd>
          </dl>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="session-state-base64" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                {t("explorer.sessionState.state")}
              </label>
              <span className="text-[10px] text-zinc-400">{t("explorer.sessionState.encoding")}</span>
            </div>
            <textarea
              id="session-state-base64"
              value={stateBase64}
              onChange={(event) => setStateBase64(event.target.value)}
              disabled={loading || saving || !loaded}
              rows={8}
              spellCheck={false}
              className="selectable w-full resize-y rounded border border-zinc-300 bg-transparent px-2.5 py-2 font-mono text-xs text-zinc-800 focus:outline-none focus:ring-1 focus:ring-azure-primary disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200"
            />
            <div className="flex items-center justify-between text-[10px] text-zinc-400">
              <span>{loaded && !hasState ? t("explorer.sessionState.noState") : ""}</span>
              <span>{byteLength === null ? "—" : t("explorer.sessionState.bytes", { count: byteLength })}</span>
            </div>
          </div>

          {loading && <p role="status" className="text-xs text-zinc-500 dark:text-zinc-400">Loading…</p>}
          {error && <p role="alert" className="rounded bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">{error}</p>}

          {confirmation && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-900/20">
              <p className="font-semibold text-amber-800 dark:text-amber-300">
                {t(`explorer.sessionState.${confirmation === "set" ? "confirmSetTitle" : "confirmClearTitle"}`)}
              </p>
              <p className="mt-1 text-amber-700 dark:text-amber-400">
                {t(`explorer.sessionState.${confirmation === "set" ? "confirmSetBody" : "confirmClearBody"}`)}
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmation(null)} disabled={saving} className="rounded border border-zinc-300 px-2.5 py-1 text-[11px] text-zinc-600 dark:border-zinc-600 dark:text-zinc-300">
                  {t("explorer.sessionState.cancel")}
                </button>
                <button type="button" onClick={() => void confirmMutation()} disabled={saving} className="rounded bg-amber-600 px-2.5 py-1 text-[11px] text-white disabled:opacity-40">
                  {t(`explorer.sessionState.${confirmation === "set" ? "confirmSet" : "confirmClear"}`)}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-700">
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {t("explorer.sessionState.close")}
          </button>
          <button type="button" onClick={() => setConfirmation("clear")} disabled={!loaded || !hasState || saving || confirmation !== null} className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20">
            {t("explorer.sessionState.clear")}
          </button>
          <button type="button" onClick={requestSet} disabled={!loaded || saving || confirmation !== null} className="rounded bg-azure-primary px-3 py-1.5 text-xs text-white hover:bg-azure-primary/90 disabled:opacity-40">
            {t("explorer.sessionState.set")}
          </button>
        </div>
      </div>
    </div>
  );
}
