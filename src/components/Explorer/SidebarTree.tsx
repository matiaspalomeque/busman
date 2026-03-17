import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import { Icon } from "../Common/Icon";

// ─── Count badge ────────────────────────────────────────────────────────────

interface CountBadgeProps {
  active: number;
  dlq: number;
  threshold?: number | null;
}

function CountBadge({ active, dlq, threshold }: CountBadgeProps) {
  const { t } = useTranslation();
  const breached = threshold != null && dlq > threshold;
  return (
    <span
      className="ml-auto flex items-center gap-0.5 shrink-0 text-[10px] tabular-nums"
      title={breached ? t("explorer.sidebar.dlqThresholdBreached", { count: dlq, threshold }) : undefined}
    >
      <span className="text-zinc-500 dark:text-zinc-400">{active}</span>
      <span className="text-zinc-300 dark:text-zinc-600 mx-0.5">·</span>
      {breached && <Icon name="alertTriangle" size={8} className="text-red-500 dark:text-red-400 shrink-0" />}
      <span
        className={
          breached
            ? "text-red-500 dark:text-red-400 font-bold"
            : dlq > 0
              ? "text-amber-500 dark:text-amber-400 font-medium"
              : "text-zinc-400 dark:text-zinc-600"
        }
      >
        {dlq}
      </span>
    </span>
  );
}

// ─── Tree section ───────────────────────────────────────────────────────────

interface TreeSectionProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

export function TreeSection({ label, collapsed, onToggle, children }: TreeSectionProps) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-1 w-full px-2 py-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider hover:text-azure-dark dark:hover:text-azure-light"
      >
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {label}
      </button>
      {!collapsed && <div className="pb-1">{children}</div>}
    </div>
  );
}

// ─── Threshold popover ──────────────────────────────────────────────────────

interface ThresholdPopoverProps {
  current: number | null;
  onSave: (value: number | null) => void;
  onClose: () => void;
}

function ThresholdPopover({ current, onSave, onClose }: ThresholdPopoverProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(current != null ? String(current) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter") {
        const n = Number(value);
        onSave(!isNaN(n) && n > 0 ? n : null);
        onClose();
      }
    },
    [value, onSave, onClose]
  );

  return (
    <div
      className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 rounded-md shadow-lg p-2 flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="number"
        min={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("explorer.sidebar.dlqThresholdPlaceholder")}
        className="w-16 text-xs px-1.5 py-1 rounded border border-zinc-200 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
      />
      <button
        onClick={() => {
          const n = Number(value);
          onSave(!isNaN(n) && n > 0 ? n : null);
          onClose();
        }}
        className="text-[10px] px-1.5 py-1 rounded bg-azure-primary text-white hover:bg-azure-primary/80"
      >
        {t("explorer.sidebar.dlqThresholdSave")}
      </button>
      {current != null && (
        <button
          onClick={() => {
            onSave(null);
            onClose();
          }}
          className="text-[10px] px-1.5 py-1 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          {t("explorer.sidebar.dlqThresholdClear")}
        </button>
      )}
    </div>
  );
}

// ─── Tree item ──────────────────────────────────────────────────────────────

export interface TreeItemProps {
  label: string;
  itemTitle?: string;
  icon: "queue" | "topic";
  isSelected: boolean;
  onClick: () => void;
  indent?: boolean;
  counts?: { active: number; dlq: number } | null;
  pinKey?: string;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onDelete?: () => void;
  threshold?: number | null;
  onSetThreshold?: (value: number | null) => void;
}

export function TreeItem({ label, itemTitle, icon, isSelected, onClick, indent = false, counts, pinKey, isPinned = false, onTogglePin, onDelete, threshold, onSetThreshold }: TreeItemProps) {
  const { t } = useTranslation();
  const [showPopover, setShowPopover] = useState(false);
  return (
    <div
      className={[
        "group relative flex items-center w-full rounded-sm",
        isSelected
          ? "bg-azure-primary/10"
          : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
      ].join(" ")}
    >
      <button
        onClick={onClick}
        title={itemTitle ?? label}
        className={[
          "flex items-center gap-2 flex-1 min-w-0 text-left text-xs py-1",
          indent ? "pl-7" : "pl-4",
          pinKey != null || onDelete != null || onSetThreshold != null ? "pr-1" : "pr-2",
          isSelected
            ? "text-azure-primary font-medium"
            : "text-azure-secondary dark:text-zinc-300",
        ].join(" ")}
      >
        <Icon
          name={icon}
          size={13}
          className={isSelected ? "text-azure-primary" : "text-zinc-400 dark:text-zinc-500 shrink-0"}
        />
        <span className="truncate min-w-0 flex-1">{label}</span>
        {counts != null && <CountBadge active={counts.active} dlq={counts.dlq} threshold={threshold} />}
      </button>
      {onDelete != null && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title={t("explorer.sidebar.deleteTitle")}
          className="shrink-0 p-0.5 rounded text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
        >
          <Icon name="trash" size={11} />
        </button>
      )}
      {onSetThreshold != null && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowPopover((v) => !v); }}
          title={t("explorer.sidebar.dlqThresholdSet")}
          className={[
            "shrink-0 p-0.5 rounded transition-opacity",
            threshold != null
              ? "text-amber-500 dark:text-amber-400 opacity-100"
              : "text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-amber-500",
          ].join(" ")}
        >
          <Icon name={threshold != null ? "bellFilled" : "bell"} size={11} />
        </button>
      )}
      {pinKey != null && (
        <button
          onClick={(e) => { e.stopPropagation(); onTogglePin?.(); }}
          title={isPinned ? t("explorer.sidebar.unpin") : t("explorer.sidebar.pin")}
          className={[
            "shrink-0 p-0.5 mr-1 rounded transition-opacity",
            isPinned
              ? "text-amber-400 opacity-100"
              : "text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-amber-400",
          ].join(" ")}
        >
          <Icon name={isPinned ? "starFilled" : "star"} size={11} />
        </button>
      )}
      {showPopover && onSetThreshold != null && (
        <ThresholdPopover
          current={threshold ?? null}
          onSave={onSetThreshold}
          onClose={() => setShowPopover(false)}
        />
      )}
    </div>
  );
}

// ─── Topic node ─────────────────────────────────────────────────────────────

interface TopicNodeProps {
  topic: string;
  subscriptions: string[];
  subCounts: Map<string, { active: number; dlq: number }>;
  dlqThresholds: Record<string, number>;
  onSetThreshold: (entityKey: string, value: number | null) => void;
}

export function TopicNode({ topic, subscriptions, subCounts, dlqThresholds, onSetThreshold }: TopicNodeProps) {
  const { t } = useTranslation();
  const { explorerSelection, setExplorerSubscription, pinnedEntities, togglePin, setDeleteEntityTarget } = useAppStore();
  const pinnedSet = useMemo(() => new Set(pinnedEntities), [pinnedEntities]);
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <div className="group flex items-center w-full rounded-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
        <button
          onClick={() => setExpanded((e) => !e)}
          title={topic}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-xs py-1 pl-4 pr-1 text-azure-secondary dark:text-zinc-300 truncate"
        >
          <svg
            width={11}
            height={11}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <Icon name="topic" size={13} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
          <span className="truncate">{topic}</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setDeleteEntityTarget({ type: "topic", name: topic }); }}
          title={t("explorer.sidebar.deleteTitle")}
          className="shrink-0 p-0.5 mr-1 rounded text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
        >
          <Icon name="trash" size={11} />
        </button>
      </div>
      {expanded &&
        subscriptions.map((sub) => {
          const isSelected =
            explorerSelection.kind === "subscription" &&
            explorerSelection.topicName === topic &&
            explorerSelection.subscriptionName === sub;
          const pinKey = `subscription:${topic}\0${sub}`;
          const thresholdKey = `subscription:${topic}\0${sub}`;
          return (
            <TreeItem
              key={sub}
              label={sub}
              icon="queue"
              isSelected={isSelected}
              onClick={() => setExplorerSubscription(topic, sub)}
              indent
              counts={subCounts.get(`${topic}/${sub}`) ?? null}
              pinKey={pinKey}
              isPinned={pinnedSet.has(pinKey)}
              onTogglePin={() => togglePin(pinKey)}
              onDelete={() => setDeleteEntityTarget({ type: "subscription", name: sub, topicName: topic })}
              threshold={dlqThresholds[thresholdKey] ?? null}
              onSetThreshold={(v) => onSetThreshold(thresholdKey, v)}
            />
          );
        })}
    </div>
  );
}
