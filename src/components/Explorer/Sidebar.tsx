import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import { useEntityList } from "../../hooks/useEntityList";
import { useResizable } from "../../hooks/useResizable";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";

interface CountBadgeProps {
  active: number;
  dlq: number;
}

function CountBadge({ active, dlq }: CountBadgeProps) {
  return (
    <span className="ml-auto flex items-center gap-1 shrink-0 text-[10px] tabular-nums">
      <span className="text-zinc-500 dark:text-zinc-400">{active}</span>
      <span className="text-zinc-300 dark:text-zinc-600">·</span>
      <span className={dlq > 0 ? "text-amber-500 dark:text-amber-400 font-medium" : "text-zinc-400 dark:text-zinc-600"}>{dlq}</span>
    </span>
  );
}

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
  itemTitle?: string;
  icon: "queue" | "topic";
  isSelected: boolean;
  onClick: () => void;
  indent?: boolean;
  counts?: { active: number; dlq: number } | null;
  pinKey?: string;
  isPinned?: boolean;
  onTogglePin?: () => void;
}

function TreeItem({ label, itemTitle, icon, isSelected, onClick, indent = false, counts, pinKey, isPinned = false, onTogglePin }: TreeItemProps) {
  const { t } = useTranslation();
  return (
    <div
      className={[
        "group flex items-center w-full rounded-sm",
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
          pinKey != null ? "pr-1" : "pr-2",
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
        {counts != null && <CountBadge active={counts.active} dlq={counts.dlq} />}
      </button>
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
    </div>
  );
}

interface TopicNodeProps {
  topic: string;
  subscriptions: string[];
  subCounts: Map<string, { active: number; dlq: number }>;
}

function TopicNode({ topic, subscriptions, subCounts }: TopicNodeProps) {
  const { explorerSelection, setExplorerSubscription, pinnedEntities, togglePin } = useAppStore();
  const pinnedSet = useMemo(() => new Set(pinnedEntities), [pinnedEntities]);
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
          const pinKey = `subscription:${topic}\0${sub}`;
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
            />
          );
        })}
    </div>
  );
}

// ─── Pinned item types ────────────────────────────────────────────────────────

type PinnedItem =
  | { type: "queue"; name: string; key: string }
  | { type: "subscription"; topicName: string; subName: string; key: string };

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
    setExplorerSubscription,
    sidebarCollapsed,
    toggleSidebarSection,
    isDark,
    toggleDark,
    language,
    setLanguage,
    setIsAboutModalOpen,
    entityCounts,
    sidebarWidth,
    setSidebarWidth,
    pinnedEntities,
    togglePin,
  } = useAppStore();

  const { widthRef, onPointerDown } = useResizable({
    initialWidth: sidebarWidth,
    minWidth: 180,
    maxWidth: 480,
    onDragEnd: setSidebarWidth,
  });

  // Build lookup maps for O(1) access in render — memoized to avoid new references on every render
  const queueCountMap = useMemo(
    () => new Map((entityCounts?.queues ?? []).map((q) => [q.name, { active: q.active, dlq: q.dlq }])),
    [entityCounts]
  );
  const subCountMap = useMemo(
    () =>
      new Map(
        (entityCounts?.subscriptions ?? []).map((s) => [
          `${s.topic}/${s.subscription}`,
          { active: s.active, dlq: s.dlq },
        ])
      ),
    [entityCounts]
  );

  const pinnedSet = useMemo(() => new Set(pinnedEntities), [pinnedEntities]);

  // Build a Set of valid pin keys from the loaded entities. This constructs keys
  // exactly the same way TopicNode / queue TreeItems do, so membership is guaranteed
  // to match. Avoids property-access lookups like entities.topics[name] which can
  // silently fail if the object has unexpected prototype/proxy behaviour after Immer.
  const validPinKeys = useMemo(() => {
    if (!entities) return new Set<string>();
    const keys = new Set<string>();
    for (const q of entities.queues) keys.add(`queue:${q}`);
    for (const [topic, subs] of Object.entries(entities.topics)) {
      for (const sub of subs) keys.add(`subscription:${topic}\0${sub}`);
    }
    return keys;
  }, [entities]);

  const pinnedItems = useMemo<PinnedItem[]>(() => {
    if (pinnedEntities.length === 0 || validPinKeys.size === 0) return [];
    return pinnedEntities.flatMap<PinnedItem>((key) => {
      if (!validPinKeys.has(key)) return [];
      if (key.startsWith("queue:")) {
        return [{ type: "queue", name: key.slice(6), key }];
      }
      if (key.startsWith("subscription:")) {
        const rest = key.slice(13);
        const sepIdx = rest.indexOf("\0");
        if (sepIdx < 1) return [];
        return [{
          type: "subscription",
          topicName: rest.slice(0, sepIdx),
          subName: rest.slice(sepIdx + 1),
          key,
        }];
      }
      return [];
    });
  }, [pinnedEntities, validPinKeys]);

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

  // Keep widthRef in sync with store value (e.g. on first render after persistence loads)
  widthRef.current = sidebarWidth;

  return (
    <aside
      className="flex flex-col border-r border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden shrink-0 relative"
      style={{ width: sidebarWidth }}
    >
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
          <div className="px-3 py-4 flex items-center gap-2 text-xs text-zinc-400">
            <Icon name="loader" size={14} className="animate-spin shrink-0" />
            {t("explorer.sidebar.loadingEntities")}
          </div>
        )}

        {!entitiesLoading && entitiesError && (
          <div className="px-3 py-3 space-y-1.5">
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("explorer.sidebar.loadError")}</p>
            <button
              onClick={() => void refreshEntities()}
              className="text-xs text-azure-primary hover:underline"
            >
              {t("explorer.sidebar.retry")}
            </button>
          </div>
        )}

        {!entitiesLoading && !entities && !entitiesError && (
          <div className="px-3 py-3 text-xs text-zinc-400">
            {t("explorer.sidebar.selectConnection")}
          </div>
        )}

        {/* Favorites section — shown regardless of filter, only when there are pins */}
        {pinnedItems.length > 0 && (
          <div>
            <div className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
              <Icon name="starFilled" size={10} className="text-amber-400 shrink-0" />
              {t("explorer.sidebar.favoritesSection")}
            </div>
            {pinnedItems.map((item) => {
              if (item.type === "queue") {
                return (
                  <TreeItem
                    key={item.key}
                    label={item.name}
                    icon="queue"
                    isSelected={explorerSelection.kind === "queue" && explorerSelection.queueName === item.name}
                    onClick={() => setExplorerQueue(item.name)}
                    counts={queueCountMap.get(item.name) ?? null}
                    pinKey={item.key}
                    isPinned={true}
                    onTogglePin={() => togglePin(item.key)}
                  />
                );
              }
              return (
                <TreeItem
                  key={item.key}
                  label={item.subName}
                  itemTitle={`${item.topicName} / ${item.subName}`}
                  icon="queue"
                  isSelected={
                    explorerSelection.kind === "subscription" &&
                    explorerSelection.topicName === item.topicName &&
                    explorerSelection.subscriptionName === item.subName
                  }
                  onClick={() => setExplorerSubscription(item.topicName, item.subName)}
                  counts={subCountMap.get(`${item.topicName}/${item.subName}`) ?? null}
                  pinKey={item.key}
                  isPinned={true}
                  onTogglePin={() => togglePin(item.key)}
                />
              );
            })}
          </div>
        )}

        {hasQueues && (
          <TreeSection
            label={t("explorer.sidebar.queuesSection", { count: filteredQueues.length })}
            collapsed={sidebarCollapsed.queues}
            onToggle={() => toggleSidebarSection("queues")}
          >
            {filteredQueues.map((queue) => {
              const pinKey = `queue:${queue}`;
              return (
                <TreeItem
                  key={queue}
                  label={queue}
                  icon="queue"
                  isSelected={explorerSelection.kind === "queue" && explorerSelection.queueName === queue}
                  onClick={() => setExplorerQueue(queue)}
                  counts={queueCountMap.get(queue) ?? null}
                  pinKey={pinKey}
                  isPinned={pinnedSet.has(pinKey)}
                  onTogglePin={() => togglePin(pinKey)}
                />
              );
            })}
          </TreeSection>
        )}

        {hasTopics && (
          <TreeSection
            label={t("explorer.sidebar.topicsSection", { count: Object.keys(filteredTopics).length })}
            collapsed={sidebarCollapsed.topics}
            onToggle={() => toggleSidebarSection("topics")}
          >
            {Object.entries(filteredTopics).map(([topic, subs]) => (
              <TopicNode key={topic} topic={topic} subscriptions={subs} subCounts={subCountMap} />
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
            <Icon name="refresh" size={13} className={entitiesLoading ? "animate-spin" : undefined} />
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

      {/* Drag handle — sits on the right edge, 6px wide, pointer-capture for smooth drag */}
      <div
        onPointerDown={onPointerDown}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize group z-10"
        title="Drag to resize"
      >
        {/* Visible highlight on hover/active */}
        <div className="absolute inset-y-0 right-0 w-px bg-transparent group-hover:bg-azure-primary/40 group-active:bg-azure-primary/70 transition-colors" />
      </div>
    </aside>
  );
}
