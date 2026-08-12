import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../Common/Icon";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export function bodyString(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

// ─── Column filter row ────────────────────────────────────────────────────────

interface FilterRowProps {
  filters: Record<string, string>;
  visibleFilters: Set<string>;
  onChange: (key: string, value: string) => void;
}

export function FilterRow({ filters, visibleFilters, onChange }: FilterRowProps) {
  const { t } = useTranslation();
  if (visibleFilters.size === 0) return null;
  return (
    <tr className="bg-zinc-50 dark:bg-zinc-800/60">
      <td className="px-2 py-1 border-b border-zinc-200 dark:border-zinc-700" />
      <td className="px-2 py-1 border-b border-zinc-200 dark:border-zinc-700" />
      {(["messageId", "deadLetterReason", "deadLetterErrorDescription"] as const).map((key) => (
        <td key={key} className="px-2 py-1 border-b border-zinc-200 dark:border-zinc-700">
          {visibleFilters.has(key) ? (
            <input
              type="text"
              value={filters[key]}
              onChange={(e) => onChange(key, e.target.value)}
              placeholder={t("explorer.grid.filterPlaceholder")}
              aria-label={`${t("explorer.grid.filterTitle")} ${key}`}
              className="w-full text-xs px-1.5 py-0.5 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
            />
          ) : null}
        </td>
      ))}
    </tr>
  );
}

// ─── Body filter bar ──────────────────────────────────────────────────────────

interface BodyFilterBarProps {
  value: string;
  onChange: (v: string) => void;
  rightSlot?: ReactNode;
}

export function BodyFilterBar({ value, onChange, rightSlot }: BodyFilterBarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
      <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider whitespace-nowrap">
        {t("explorer.grid.bodyFilter")}
      </span>
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
        {t("explorer.grid.contains")}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("explorer.grid.searchBody")}
        aria-label={t("explorer.grid.searchBody")}
        className="min-w-[14rem] flex-1 text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-azure-primary dark:text-zinc-200"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("explorer.grid.clearBodyFilter")}
          title={t("explorer.grid.clearBodyFilter")}
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-xs focus:outline-none focus:ring-1 focus:ring-azure-primary rounded"
        >
          ✕
        </button>
      )}
      {rightSlot}
    </div>
  );
}

// ─── Column header ────────────────────────────────────────────────────────────

type FilterKey = "messageId" | "deadLetterReason" | "deadLetterErrorDescription" | "body";
type SortKey = "enqueuedTimeUtc" | "messageId";

export function ColHeader({
  label,
  filterKey,
  filterActive,
  onFilterToggle,
  sortKey,
  sortColumn,
  sortDirection,
  onSort,
}: {
  label: string;
  filterKey?: FilterKey;
  filterActive?: boolean;
  onFilterToggle?: () => void;
  sortKey?: SortKey;
  sortColumn?: SortKey | null;
  sortDirection?: "asc" | "desc";
  onSort?: (column: SortKey) => void;
}) {
  const { t } = useTranslation();
  const sortable = Boolean(sortKey && onSort);
  const isSorted = sortable && sortColumn === sortKey;
  const triggerSort = () => {
    if (sortKey && onSort) onSort(sortKey);
  };
  return (
    <th
      scope="col"
      aria-sort={isSorted ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
      className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700"
    >
      <div className="flex items-center gap-1">
        <span
          className={`flex-1 ${sortable ? "cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300 select-none" : ""}`}
          onClick={sortable ? triggerSort : undefined}
        >
          {label}
        </span>
        {sortable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              triggerSort();
            }}
            aria-label={`${t("explorer.grid.sortTitle")} ${label}`}
            className="p-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 focus:outline-none focus:ring-1 focus:ring-azure-primary"
            title={t("explorer.grid.sortTitle")}
          >
            <Icon
              name="chevronDown"
              size={10}
              className={
                isSorted
                  ? `transform ${sortDirection === "desc" ? "rotate-180" : ""}`
                  : "opacity-30"
              }
            />
          </button>
        )}
        {filterKey && onFilterToggle && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFilterToggle();
            }}
            aria-pressed={filterActive}
            aria-label={`${t("explorer.grid.filterTitle")} ${label}`}
            className={`p-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
              filterActive ? "text-azure-primary" : "text-zinc-400"
            } focus:outline-none focus:ring-1 focus:ring-azure-primary`}
            title={t("explorer.grid.filterTitle")}
          >
            <Icon name="search" size={10} />
          </button>
        )}
      </div>
    </th>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

export function EmptyState({ message, icon = "search" }: { message: string; icon?: "search" | "box" | "alertTriangle" }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td colSpan={5} className="px-4 py-16 text-center">
        <div className="flex flex-col items-center justify-center gap-4 animate-fade-in">
          <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            <Icon name={icon} size={32} className="text-zinc-300 dark:text-zinc-600" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{message}</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">{t("explorer.grid.emptyHint")}</p>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function FirstRunState({ hasConnections, onManageConnections }: { hasConnections: boolean; onManageConnections: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10 text-center">
      <div className="flex max-w-sm flex-col items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-azure-primary/10 text-azure-primary">
          <Icon name="server" size={30} />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
            {hasConnections ? t("explorer.grid.emptySelectEntity") : t("explorer.grid.emptyNoConnection")}
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            {hasConnections ? t("explorer.grid.emptySelectEntityHint") : t("explorer.grid.emptyNoConnectionHint")}
          </p>
        </div>
        <button
          type="button"
          onClick={onManageConnections}
          className="min-h-11 rounded-lg bg-azure-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-azure-600 focus:outline-none focus:ring-2 focus:ring-azure-primary focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
        >
          {hasConnections ? t("explorer.grid.manageConnections") : t("explorer.grid.addConnection")}
        </button>
      </div>
    </div>
  );
}
