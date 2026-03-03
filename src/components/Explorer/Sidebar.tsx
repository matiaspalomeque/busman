import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useEntityList } from "../../hooks/useEntityList";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";

// ─── Tree primitives ─────────────────────────────────────────────────────────

interface TreeSectionProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function TreeSection({ label, collapsed, onToggle, children }: TreeSectionProps) {
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

interface TreeItemProps {
  label: string;
  icon: "queue" | "topic";
  isSelected: boolean;
  onClick: () => void;
  indent?: boolean;
}

function TreeItem({ label, icon, isSelected, onClick, indent = false }: TreeItemProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={[
        "flex items-center gap-2 w-full text-left text-xs py-1 pr-2 rounded-sm truncate",
        indent ? "pl-7" : "pl-4",
        isSelected
          ? "bg-azure-primary/10 text-azure-primary font-medium"
          : "text-azure-secondary dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800",
      ].join(" ")}
    >
      <Icon
        name={icon}
        size={13}
        className={isSelected ? "text-azure-primary" : "text-zinc-400 dark:text-zinc-500 shrink-0"}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

interface TopicNodeProps {
  topic: string;
  subscriptions: string[];
}

function TopicNode({ topic, subscriptions }: TopicNodeProps) {
  const { explorerSelection, setExplorerSubscription } = useAppStore();
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        title={topic}
        className="flex items-center gap-1.5 w-full text-left text-xs py-1 pl-4 pr-2 rounded-sm text-azure-secondary dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 truncate"
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
      {expanded &&
        subscriptions.map((sub) => {
          const isSelected =
            explorerSelection.kind === "subscription" &&
            explorerSelection.topicName === topic &&
            explorerSelection.subscriptionName === sub;
          return (
            <TreeItem
              key={sub}
              label={sub}
              icon="queue"
              isSelected={isSelected}
              onClick={() => setExplorerSubscription(topic, sub)}
              indent
            />
          );
        })}
    </div>
  );
}

// ─── Main Sidebar ─────────────────────────────────────────────────────────────

export function Sidebar() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const { entities, entitiesLoading, entitiesError, refreshEntities } = useEntityList();
  const {
    explorerSelection,
    treeFilter,
    setTreeFilter,
    setExplorerQueue,
    sidebarCollapsed,
    toggleSidebarSection,
    isDark,
    toggleDark,
    language,
    setLanguage,
    setIsAboutModalOpen,
  } = useAppStore();

  const namespace = conn ? extractNamespace(conn.connectionString) : "";
  const filter = treeFilter.toLowerCase();

  const filteredQueues = (entities?.queues ?? []).filter(
    (q) => !filter || q.toLowerCase().includes(filter)
  );

  const filteredTopics = Object.entries(entities?.topics ?? {}).reduce<Record<string, string[]>>(
    (acc, [topic, subs]) => {
      const topicMatches = !filter || topic.toLowerCase().includes(filter);
      const matchingSubs = subs.filter((s) => !filter || s.toLowerCase().includes(filter));
      if (topicMatches || matchingSubs.length > 0) {
        acc[topic] = topicMatches ? subs : matchingSubs;
      }
      return acc;
    },
    {}
  );

  const hasQueues = filteredQueues.length > 0;
  const hasTopics = Object.keys(filteredTopics).length > 0;

  return (
    <aside className="w-60 flex flex-col border-r border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden shrink-0">
      {/* Namespace header */}
      <div className="px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-700">
        <div className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-0.5">
          {t("explorer.sidebar.namespace")}
        </div>
        <div
          className="text-xs text-azure-dark dark:text-zinc-200 truncate font-medium"
          title={namespace}
        >
          {namespace || t("explorer.sidebar.notConnected")}
        </div>
      </div>

      {/* Filter input */}
      <div className="px-2 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <div className="relative">
          <Icon
            name="search"
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
          />
          <input
            type="text"
            value={treeFilter}
            onChange={(e) => setTreeFilter(e.target.value)}
            placeholder={t("explorer.sidebar.filterPlaceholder")}
            className="w-full text-xs pl-6 pr-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-azure-primary placeholder-zinc-400 dark:placeholder-zinc-600 dark:text-zinc-200"
          />
        </div>
      </div>

      {/* Tree view */}
      <div className="flex-1 overflow-y-auto py-1 space-y-0.5">
        {entitiesLoading && !entities && (
          <div className="px-3 py-3 text-xs text-zinc-400">{t("explorer.sidebar.loadingEntities")}</div>
        )}

        {!entitiesLoading && !entities && !entitiesError && (
          <div className="px-3 py-3 text-xs text-zinc-400">
            {t("explorer.sidebar.selectConnection")}
          </div>
        )}

        {hasQueues && (
          <TreeSection
            label={t("explorer.sidebar.queuesSection", { count: filteredQueues.length })}
            collapsed={sidebarCollapsed.queues}
            onToggle={() => toggleSidebarSection("queues")}
          >
            {filteredQueues.map((queue) => (
              <TreeItem
                key={queue}
                label={queue}
                icon="queue"
                isSelected={
                  explorerSelection.kind === "queue" && explorerSelection.queueName === queue
                }
                onClick={() => setExplorerQueue(queue)}
              />
            ))}
          </TreeSection>
        )}

        {hasTopics && (
          <TreeSection
            label={t("explorer.sidebar.topicsSection", { count: Object.keys(filteredTopics).length })}
            collapsed={sidebarCollapsed.topics}
            onToggle={() => toggleSidebarSection("topics")}
          >
            {Object.entries(filteredTopics).map(([topic, subs]) => (
              <TopicNode key={topic} topic={topic} subscriptions={subs} />
            ))}
          </TreeSection>
        )}

        {entities && !hasQueues && !hasTopics && (
          <div className="px-3 py-3 text-xs text-zinc-400">
            {filter ? t("explorer.sidebar.noMatchFilter") : t("explorer.sidebar.noEntities")}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 py-2 border-t border-zinc-200 dark:border-zinc-700 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-400">
            {entitiesLoading ? t("explorer.sidebar.refreshing") : t("explorer.sidebar.entityTree")}
          </span>
          <button
            onClick={() => void refreshEntities()}
            disabled={entitiesLoading}
            className="p-1 rounded text-zinc-400 hover:text-azure-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
            title={t("explorer.sidebar.refreshTitle")}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          {/* Theme toggle */}
          <button
            onClick={toggleDark}
            className="p-1.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            title={isDark ? t("sidebar.lightMode") : t("sidebar.darkMode")}
            aria-label={isDark ? t("sidebar.lightMode") : t("sidebar.darkMode")}
          >
            <Icon name={isDark ? "sun" : "moon"} size={14} />
          </button>

          {/* Language toggle */}
          <div className="flex items-center border border-zinc-300 dark:border-zinc-600 rounded overflow-hidden">
            {(["en", "es"] as const).map((lang) => (
              <button
                key={lang}
                onClick={() => setLanguage(lang)}
                className={[
                  "px-2.5 py-1.5 text-xs transition-colors uppercase font-medium",
                  language === lang
                    ? "bg-azure-primary text-white"
                    : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700",
                ].join(" ")}
              >
                {lang}
              </button>
            ))}
          </div>

          {/* About button */}
          <button
            onClick={() => setIsAboutModalOpen(true)}
            className="p-1.5 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            title={t("sidebar.about")}
            aria-label={t("sidebar.about")}
          >
            <Icon name="info" size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
