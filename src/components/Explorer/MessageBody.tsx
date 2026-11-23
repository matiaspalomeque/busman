import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { bodyString, formatBodyJson } from "../../utils/messageBody";

export function MessageBody({ body, onExpand }: { body: unknown; onExpand?: () => void }) {
  const { t } = useTranslation();
  const [formatted, setFormatted] = useState(true);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(-1);
  const [copyStatus, setCopyStatus] = useState("");
  const text = useMemo(() => formatted ? formatBodyJson(body) : bodyString(body), [body, formatted]);
  const displayText = useMemo(() => text.replace(/\r\n?/g, "\n"), [text]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => {
    if (!query) return [];
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return Array.from(displayText.matchAll(new RegExp(literal, "giu")), (result) => result.index!);
  }, [displayText, query]);
  const findNext = () => {
    if (!matches.length) return;
    const next = (match + 1) % matches.length;
    setMatch(next);
    const textarea = textRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(matches[next], matches[next] + query.length);
    textarea.scrollTop = Math.max(0, (displayText.slice(0, matches[next]).split("\n").length - 3) * 16);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopyStatus(t("explorer.properties.copied")); }
    catch { setCopyStatus(t("explorer.properties.copyFailed")); }
  };
  return <div className="flex grow shrink-0 flex-col gap-2 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-2 text-[11px] text-azure-primary">
        <button onClick={() => { setFormatted((value) => !value); setMatch(-1); }} aria-pressed={formatted} className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1">{t(formatted ? "explorer.properties.formatted" : "explorer.properties.raw")}</button>
        <button onClick={() => void copy()} className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1">{t("explorer.properties.copyBody")}</button>
        {onExpand && <button onClick={onExpand} className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1">{t("explorer.properties.expand")}</button>}
        <span role="status" className="text-zinc-500">{copyStatus}</span>
      </div>
      <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap gap-1 text-xs">
        <input aria-label={t("explorer.properties.findBody")} placeholder={t("explorer.properties.findBody")} value={query}
          onChange={(event) => { setQuery(event.target.value); setMatch(-1); }} onKeyDown={(event) => { if (event.key === "Enter") findNext(); }}
          className="min-w-0 flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-transparent px-2 py-1" />
        <button disabled={!matches.length} onClick={findNext} className="px-2 text-azure-primary disabled:opacity-40">{t("explorer.properties.findNext")}</button>
        {query && <span role="status" className="w-full text-[10px] text-zinc-500">{t("explorer.properties.matches", { count: matches.length })}</span>}
      </div>
    </div>
    <textarea ref={textRef} readOnly spellCheck={false} aria-label={t("explorer.properties.body")} value={displayText}
      placeholder={t("explorer.properties.bodyEmpty")}
      className="selectable w-full flex-1 min-h-48 resize-none rounded bg-zinc-50 dark:bg-zinc-950 p-2 text-[11px] leading-4 font-mono text-azure-dark dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-azure-primary" />
  </div>;
}

export function ExpandedMessageBody({ body, onClose }: { body: unknown; onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  return <div className="fixed inset-0 z-50 bg-black/40 p-6 flex" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("explorer.properties.body")} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
      className="flex flex-col flex-1 min-w-0 rounded-lg shadow-2xl bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <h2>{t("explorer.properties.body")}</h2><button onClick={onClose} className="text-xs p-2">{t("explorer.properties.close")}</button>
      </div>
      <MessageBody body={body} />
    </div>
  </div>;
}
