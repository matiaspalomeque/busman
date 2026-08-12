import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useConnections } from "../../hooks/useConnections";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { selectActiveConnection, useAppStore } from "../../store/appStore";
import type { Connection, QueueMode } from "../../types";
import { safeColor } from "../../utils/color";
import { Icon } from "../Common/Icon";

// ─── Toolbar button ───────────────────────────────────────────────────────────

interface ToolbarButtonProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  primary?: boolean;
  warn?: boolean;
  violet?: boolean;
  active?: boolean;
}

export function ToolbarButton({ label, icon, onClick, disabled, title, danger, primary, warn, violet, active }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "flex items-center gap-2 px-3.5 py-2 text-sm font-medium border rounded-lg transition-all duration-150",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        danger
          ? "border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
          : warn
            ? "border-orange-400 dark:border-orange-600 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20"
            : primary
              ? "border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
              : violet
                ? active
                  ? "border-violet-400 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 shadow-sm"
                  : "border-violet-300 dark:border-violet-700 text-violet-500 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20"
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

export function ConfirmModal({ title, message, danger, onConfirm, onCancel }: ConfirmModalProps) {
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
          <button
            type="button"
            onClick={onCancel}
            aria-label={t("explorer.toolbar.cancel")}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="px-4 py-4">
          <p className="text-xs text-zinc-600 dark:text-zinc-300">{message}</p>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            {t("explorer.toolbar.cancel")}
          </button>
          <button
            type="button"
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

// ─── More Actions Dropdown ─────────────────────────────────────────────────────

interface MoreActionsDropdownProps {
  onMove: () => void;
  onReceive: () => void;
  onReplay: () => void;
  onRepublish: () => void;
  onManageRules: () => void;
  disabled: boolean;
  canReplay: boolean;
  canRepublish: boolean;
  canManageRules: boolean;
}

export function MoreActionsDropdown({ onMove, onReceive, onReplay, onRepublish, onManageRules, disabled, canReplay, canRepublish, canManageRules }: MoreActionsDropdownProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium border rounded-lg transition-all duration-150 border-zinc-300 dark:border-zinc-600 text-azure-secondary dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
        title={t("explorer.toolbar.moreActions")}
      >
        <Icon name="moreHorizontal" size={16} />
        <span>{t("explorer.toolbar.more")}</span>
        <Icon name="chevronDown" size={10} className="opacity-50" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full mt-2 w-48 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg z-50 overflow-hidden animate-fade-in">
          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => { onMove(); setOpen(false); }}
              disabled={disabled}
              title={t("explorer.toolbar.moveTitle")}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed dark:text-zinc-200"
            >
              <Icon name="move" size={14} />
              {t("explorer.toolbar.move")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onReceive(); setOpen(false); }}
              disabled={disabled}
              title={t("explorer.toolbar.receiveTitle")}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Icon name="box" size={14} />
              {t("explorer.toolbar.receive")}
            </button>
            {canReplay && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { onReplay(); setOpen(false); }}
                disabled={disabled}
                title={t("explorer.toolbar.replayTitle")}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Icon name="move" size={14} />
                {t("explorer.toolbar.replay")}
              </button>
            )}
            {canRepublish && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { onRepublish(); setOpen(false); }}
                disabled={disabled}
                title={t("explorer.toolbar.republishTitle")}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Icon name="send" size={14} />
                {t("explorer.toolbar.republish")}
              </button>
            )}
            {canManageRules && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { onManageRules(); setOpen(false); }}
                disabled={disabled}
                title={t("explorer.toolbar.manageRulesTitle")}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed dark:text-zinc-200"
              >
                <Icon name="settings" size={14} />
                {t("explorer.toolbar.manageRules")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Mode selector ────────────────────────────────────────────────────────────

const MODES: QueueMode[] = ["dlq", "normal", "both"];

interface ModeSelectorProps {
  value: QueueMode;
  onChange: (m: QueueMode) => void;
}

export function ModeSelector({ value, onChange }: ModeSelectorProps) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center border border-zinc-300 dark:border-zinc-600 rounded-lg overflow-hidden">
      {MODES.map((m) => (
        <button
          type="button"
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={value === m}
          className={[
            "px-3 py-2 text-sm font-medium transition-colors",
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

export function ConnectionSelector() {
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
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
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
        <div role="menu" className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg z-50 overflow-hidden">
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
                      type="button"
                      role="menuitem"
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
