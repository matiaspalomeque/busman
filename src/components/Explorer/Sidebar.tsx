import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection, SUBSCRIPTION_KEY_SEP } from "../../store/appStore";
import { useEntityList } from "../../hooks/useEntityList";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
import { useDlqAlerts } from "../../hooks/useDlqAlerts";
import { useResizable } from "../../hooks/useResizable";
import { Icon } from "../Common/Icon";
import { extractNamespace } from "../../utils/connection";
import { safeColor } from "../../utils/color";
import { TreeSection, TreeItem, TopicNode } from "./SidebarTree";
import type { Connection } from "../../types";

// ─── Pinned item types ────────────────────────────────────────────────────────

type PinnedItem =
  | { type: "queue"; name: string; key: string }
  | { type: "subscription"; topicName: string; subName: string; key: string };

function SidebarEnvironmentBadge({ connection }: { connection: Connection | null | undefined }) {
  const { t } = useTranslation();
  const color = safeColor(connection?.environmentColor);
  if (!connection?.environment || !color) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-medium mt-0.5"
      style={{ color }}
    >
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {t(`explorer.connectionsModal.env.${connection.environment}`, connection.environment)}
    </span>
  );
}

// ─── Main Sidebar ─────────────────────────────────────────────────────────────

export function Sidebar() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const { entities, entitiesLoading, entitiesError, refreshEntities, refreshEntityCount, refreshAllCounts } = useEntityList();
  useAutoRefresh(refreshAllCounts);
  useDlqAlerts();
  const {
    explorerSelection,
    treeFilter,
    setTreeFilter,
    setExplorerQueue,
    setExplorerSubscription,
    sidebarCollapsed,
    toggleSidebarSection,
    queueCounts,
    subscriptionCounts,
    sidebarWidth,
    setSidebarWidth,
    pinnedEntities,
    togglePin,
    setIsCreateEntityModalOpen,
    setDeleteEntityTarget,
    dlqThresholds,
    setDlqThreshold,
    changedEntities,
    entityCountHistory,
    sparklineEnabled,
  } = useAppStore();

  const { widthRef, onPointerDown } = useResizable({
    initialWidth: sidebarWidth,
    minWidth: 180,
    maxWidth: 480,
    onDragEnd: setSidebarWidth,
  });

  // Build lookup maps for O(1) access in render — memoized to avoid new references on every render
  // subscriptionCounts uses "\0" separator internally; subCountMap converts to "/" for TopicNode/TreeItem
  const queueCountMap = useMemo(
    () => new Map(Object.entries(queueCounts)),
    [queueCounts]
  );
  const subCountMap = useMemo(
    () => new Map(Object.entries(subscriptionCounts).map(([k, v]) => [k.replace(SUBSCRIPTION_KEY_SEP, "/"), v])),
    [subscriptionCounts]
  );

  // Sparkline maps — keyed the same way as entityCountHistory
  // For subscriptions TopicNode expects Map<"sub:topic/sub", number[]>
  const subSparklineMap = useMemo(
    () => new Map(Object.entries(entityCountHistory).filter(([k]) => k.startsWith("sub:"))),
    [entityCountHistory]
  );

  const pinnedSet = useMemo(() => new Set(pinnedEntities), [pinnedEntities]);
  const changedSet = useMemo(() => new Set(changedEntities), [changedEntities]);

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
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
        <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1">
          {t("explorer.sidebar.namespace")}
        </div>
        <div
          className="text-sm text-azure-dark dark:text-zinc-200 truncate font-medium"
          title={namespace}
        >
          {namespace || t("explorer.sidebar.notConnected")}
        </div>
        <SidebarEnvironmentBadge connection={conn} />
      </div>

      {/* Filter input + create button */}
      <div className="px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-2">
        <div className="relative flex-1">
          <Icon
            name="search"
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
          />
          <input
            type="text"
            value={treeFilter}
            onChange={(e) => setTreeFilter(e.target.value)}
            placeholder={t("explorer.sidebar.filterPlaceholder")}
            className="w-full text-sm pl-8 pr-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-600 bg-transparent focus:outline-none focus:ring-2 focus:ring-azure-primary/50 placeholder-zinc-400 dark:placeholder-zinc-600 dark:text-zinc-200"
          />
        </div>
        {entities && (
          <button
            onClick={() => setIsCreateEntityModalOpen(true)}
            title={t("explorer.sidebar.createEntityTitle")}
            className="shrink-0 p-2 rounded-lg text-zinc-400 hover:text-azure-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <Icon name="plus" size={15} />
          </button>
        )}
      </div>

      {/* Tree view */}
      <div className="flex-1 overflow-y-auto py-2 space-y-1">
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

        {/* Favorites section */}
        {pinnedItems.length > 0 && (
          <div>
            <div className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
              <Icon name="starFilled" size={10} className="text-amber-400 shrink-0" />
              {t("explorer.sidebar.favoritesSection")}
            </div>
            {pinnedItems.map((item) => {
              if (item.type === "queue") {
                const thresholdKey = `queue:${item.name}`;
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
                    threshold={dlqThresholds[thresholdKey] ?? null}
                    onSetThreshold={(v) => setDlqThreshold(thresholdKey, v)}
                    onRefreshCount={() => refreshEntityCount({ type: "queue", name: item.name })}
                    flash={changedSet.has(`queue:${item.name}`)}
                    sparkline={sparklineEnabled ? (entityCountHistory[`queue:${item.name}`] ?? null) : undefined}
                  />
                );
              }
              const thresholdKey = `subscription:${item.topicName}\0${item.subName}`;
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
                  threshold={dlqThresholds[thresholdKey] ?? null}
                  onSetThreshold={(v) => setDlqThreshold(thresholdKey, v)}
                  onRefreshCount={() => refreshEntityCount({ type: "subscription", topicName: item.topicName, subscriptionName: item.subName })}
                  flash={changedSet.has(`sub:${item.topicName}/${item.subName}`)}
                  sparkline={sparklineEnabled ? (entityCountHistory[`sub:${item.topicName}/${item.subName}`] ?? null) : undefined}
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
              const thresholdKey = `queue:${queue}`;
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
                  onDelete={() => setDeleteEntityTarget({ type: "queue", name: queue })}
                  threshold={dlqThresholds[thresholdKey] ?? null}
                  onSetThreshold={(v) => setDlqThreshold(thresholdKey, v)}
                  onRefreshCount={() => refreshEntityCount({ type: "queue", name: queue })}
                  flash={changedSet.has(`queue:${queue}`)}
                  sparkline={sparklineEnabled ? (entityCountHistory[`queue:${queue}`] ?? null) : undefined}
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
              <TopicNode key={topic} topic={topic} subscriptions={subs} subCounts={subCountMap} dlqThresholds={dlqThresholds} onSetThreshold={setDlqThreshold} onRefreshSubscriptionCount={(t, s) => refreshEntityCount({ type: "subscription", topicName: t, subscriptionName: s })} changedSet={changedSet} subSparklines={sparklineEnabled ? subSparklineMap : undefined} />
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
      <div className="px-3 py-2.5 border-t border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-zinc-400">
            {entitiesLoading ? t("explorer.sidebar.refreshing") : t("explorer.sidebar.entityTree")}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refreshEntities()}
              disabled={entitiesLoading}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-azure-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
              title={t("explorer.sidebar.refreshTitle")}
            >
              <Icon name="refresh" size={14} className={entitiesLoading ? "animate-spin" : undefined} />
            </button>
          </div>
        </div>
      </div>

      {/* Drag handle */}
      <div
        onPointerDown={onPointerDown}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize group z-10"
        title="Drag to resize"
      >
        <div className="absolute inset-y-0 right-0 w-px bg-transparent group-hover:bg-azure-primary/40 group-active:bg-azure-primary/70 transition-colors" />
      </div>
    </aside>
  );
}
