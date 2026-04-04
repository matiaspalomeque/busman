import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, selectActiveConnection } from "../../store/appStore";
import type { EntityProperties, QueueProperties, SubscriptionProperties, TopicProperties } from "../../types";
import { formatBytes, formatDuration, formatTimestamp } from "./entityDetailsFormat";
import { extractNamespace } from "../../utils/connection";

// ─── Reusable section / row components ──────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-700">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-1.5 border-b border-zinc-100 dark:border-zinc-800">
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">{label}</span>
      <span className="text-[11px] text-zinc-800 dark:text-zinc-200 text-right break-all">{value}</span>
    </div>
  );
}

function BoolRow({ label, value, t }: { label: string; value: boolean | null; t: (key: string) => string }) {
  if (value === null) return null;
  return <PropRow label={label} value={value ? t("explorer.entityDetails.yes") : t("explorer.entityDetails.no")} />;
}

// ─── Entity-type-specific renderers ─────────────────────────────────────────

function QueueDetails({ data, t }: { data: QueueProperties; t: (key: string) => string }) {
  const hasForwarding = data.forwardTo || data.forwardDeadLetteredMessagesTo;
  const neverLabel = t("explorer.entityDetails.never");

  return (
    <>
      <SectionHeader label={t("explorer.entityDetails.configuration")} />
      {data.status != null && <PropRow label={t("explorer.entityDetails.status")} value={data.status} />}
      {data.maxSizeInMegabytes != null && <PropRow label={t("explorer.entityDetails.maxSizeInMegabytes")} value={data.maxSizeInMegabytes.toLocaleString()} />}
      {data.maxMessageSizeInKilobytes != null && <PropRow label={t("explorer.entityDetails.maxMessageSizeInKilobytes")} value={data.maxMessageSizeInKilobytes.toLocaleString()} />}
      <PropRow label={t("explorer.entityDetails.lockDuration")} value={formatDuration(data.lockDuration, neverLabel)} />
      <PropRow label={t("explorer.entityDetails.defaultMessageTimeToLive")} value={formatDuration(data.defaultMessageTimeToLive, neverLabel)} />
      {data.maxDeliveryCount != null && <PropRow label={t("explorer.entityDetails.maxDeliveryCount")} value={data.maxDeliveryCount} />}
      <BoolRow label={t("explorer.entityDetails.enablePartitioning")} value={data.enablePartitioning} t={t} />
      <BoolRow label={t("explorer.entityDetails.requiresSession")} value={data.requiresSession} t={t} />
      <BoolRow label={t("explorer.entityDetails.requiresDuplicateDetection")} value={data.requiresDuplicateDetection} t={t} />
      <BoolRow label={t("explorer.entityDetails.deadLetteringOnMessageExpiration")} value={data.deadLetteringOnMessageExpiration} t={t} />
      <BoolRow label={t("explorer.entityDetails.enableBatchedOperations")} value={data.enableBatchedOperations} t={t} />
      <PropRow label={t("explorer.entityDetails.autoDeleteOnIdle")} value={formatDuration(data.autoDeleteOnIdle, neverLabel)} />

      {hasForwarding && (
        <>
          <SectionHeader label={t("explorer.entityDetails.forwarding")} />
          {data.forwardTo && <PropRow label={t("explorer.entityDetails.forwardTo")} value={data.forwardTo} />}
          {data.forwardDeadLetteredMessagesTo && <PropRow label={t("explorer.entityDetails.forwardDeadLetteredMessagesTo")} value={data.forwardDeadLetteredMessagesTo} />}
        </>
      )}

      <SectionHeader label={t("explorer.entityDetails.runtime")} />
      <PropRow label={t("explorer.entityDetails.sizeInBytes")} value={formatBytes(data.sizeInBytes)} />
      <PropRow label={t("explorer.entityDetails.activeMessageCount")} value={data.activeMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.deadLetterMessageCount")} value={data.deadLetterMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.scheduledMessageCount")} value={data.scheduledMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.transferMessageCount")} value={data.transferMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.totalMessageCount")} value={data.totalMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.createdAt")} value={formatTimestamp(data.createdAt)} />
      <PropRow label={t("explorer.entityDetails.updatedAt")} value={formatTimestamp(data.updatedAt)} />
      <PropRow label={t("explorer.entityDetails.accessedAt")} value={formatTimestamp(data.accessedAt)} />
    </>
  );
}

function TopicDetails({ data, t }: { data: TopicProperties; t: (key: string) => string }) {
  const neverLabel = t("explorer.entityDetails.never");

  return (
    <>
      <SectionHeader label={t("explorer.entityDetails.configuration")} />
      {data.status != null && <PropRow label={t("explorer.entityDetails.status")} value={data.status} />}
      {data.maxSizeInMegabytes != null && <PropRow label={t("explorer.entityDetails.maxSizeInMegabytes")} value={data.maxSizeInMegabytes.toLocaleString()} />}
      {data.maxMessageSizeInKilobytes != null && <PropRow label={t("explorer.entityDetails.maxMessageSizeInKilobytes")} value={data.maxMessageSizeInKilobytes.toLocaleString()} />}
      <PropRow label={t("explorer.entityDetails.defaultMessageTimeToLive")} value={formatDuration(data.defaultMessageTimeToLive, neverLabel)} />
      <BoolRow label={t("explorer.entityDetails.enablePartitioning")} value={data.enablePartitioning} t={t} />
      <BoolRow label={t("explorer.entityDetails.requiresDuplicateDetection")} value={data.requiresDuplicateDetection} t={t} />
      <BoolRow label={t("explorer.entityDetails.supportOrdering")} value={data.supportOrdering} t={t} />
      <BoolRow label={t("explorer.entityDetails.enableBatchedOperations")} value={data.enableBatchedOperations} t={t} />
      <PropRow label={t("explorer.entityDetails.autoDeleteOnIdle")} value={formatDuration(data.autoDeleteOnIdle, neverLabel)} />

      <SectionHeader label={t("explorer.entityDetails.runtime")} />
      <PropRow label={t("explorer.entityDetails.sizeInBytes")} value={formatBytes(data.sizeInBytes)} />
      <PropRow label={t("explorer.entityDetails.subscriptionCount")} value={data.subscriptionCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.scheduledMessageCount")} value={data.scheduledMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.createdAt")} value={formatTimestamp(data.createdAt)} />
      <PropRow label={t("explorer.entityDetails.updatedAt")} value={formatTimestamp(data.updatedAt)} />
      <PropRow label={t("explorer.entityDetails.accessedAt")} value={formatTimestamp(data.accessedAt)} />
    </>
  );
}

function SubscriptionDetails({ data, t }: { data: SubscriptionProperties; t: (key: string) => string }) {
  const hasForwarding = data.forwardTo || data.forwardDeadLetteredMessagesTo;
  const neverLabel = t("explorer.entityDetails.never");

  return (
    <>
      <SectionHeader label={t("explorer.entityDetails.configuration")} />
      {data.status != null && <PropRow label={t("explorer.entityDetails.status")} value={data.status} />}
      <PropRow label={t("explorer.entityDetails.lockDuration")} value={formatDuration(data.lockDuration, neverLabel)} />
      <PropRow label={t("explorer.entityDetails.defaultMessageTimeToLive")} value={formatDuration(data.defaultMessageTimeToLive, neverLabel)} />
      {data.maxDeliveryCount != null && <PropRow label={t("explorer.entityDetails.maxDeliveryCount")} value={data.maxDeliveryCount} />}
      <BoolRow label={t("explorer.entityDetails.requiresSession")} value={data.requiresSession} t={t} />
      <BoolRow label={t("explorer.entityDetails.deadLetteringOnMessageExpiration")} value={data.deadLetteringOnMessageExpiration} t={t} />
      <BoolRow label={t("explorer.entityDetails.enableDeadLetteringOnFilterEvaluationExceptions")} value={data.enableDeadLetteringOnFilterEvaluationExceptions} t={t} />
      <BoolRow label={t("explorer.entityDetails.enableBatchedOperations")} value={data.enableBatchedOperations} t={t} />
      <PropRow label={t("explorer.entityDetails.autoDeleteOnIdle")} value={formatDuration(data.autoDeleteOnIdle, neverLabel)} />

      {hasForwarding && (
        <>
          <SectionHeader label={t("explorer.entityDetails.forwarding")} />
          {data.forwardTo && <PropRow label={t("explorer.entityDetails.forwardTo")} value={data.forwardTo} />}
          {data.forwardDeadLetteredMessagesTo && <PropRow label={t("explorer.entityDetails.forwardDeadLetteredMessagesTo")} value={data.forwardDeadLetteredMessagesTo} />}
        </>
      )}

      <SectionHeader label={t("explorer.entityDetails.runtime")} />
      <PropRow label={t("explorer.entityDetails.activeMessageCount")} value={data.activeMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.deadLetterMessageCount")} value={data.deadLetterMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.transferMessageCount")} value={data.transferMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.totalMessageCount")} value={data.totalMessageCount.toLocaleString()} />
      <PropRow label={t("explorer.entityDetails.createdAt")} value={formatTimestamp(data.createdAt)} />
      <PropRow label={t("explorer.entityDetails.updatedAt")} value={formatTimestamp(data.updatedAt)} />
      <PropRow label={t("explorer.entityDetails.accessedAt")} value={formatTimestamp(data.accessedAt)} />
    </>
  );
}

// ─── Loading skeleton ───────────────────────────────────────────────────────

function DetailsSkeleton() {
  return (
    <div className="animate-pulse px-4 py-3 space-y-3">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex justify-between gap-4">
          <div className="h-3 w-28 bg-zinc-200 dark:bg-zinc-700 rounded" />
          <div className="h-3 w-20 bg-zinc-200 dark:bg-zinc-700 rounded" />
        </div>
      ))}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

function EntityDetailsContent({ props }: { props: EntityProperties }) {
  const { t } = useTranslation();

  switch (props.kind) {
    case "queue":
      return <QueueDetails data={props.data} t={t} />;
    case "topic":
      return <TopicDetails data={props.data} t={t} />;
    case "subscription":
      return <SubscriptionDetails data={props.data} t={t} />;
  }
}

function entityTypeLabel(props: EntityProperties, t: (key: string) => string): string {
  switch (props.kind) {
    case "queue": return t("explorer.entityDetails.typeQueue");
    case "topic": return t("explorer.entityDetails.typeTopic");
    case "subscription": return t("explorer.entityDetails.typeSubscription");
  }
}

export function EntityDetailsPanel() {
  const { t } = useTranslation();
  const conn = useAppStore(selectActiveConnection);
  const entityProperties = useAppStore((s) => s.entityProperties);
  const entityPropertiesLoading = useAppStore((s) => s.entityPropertiesLoading);
  const entityPropertiesError = useAppStore((s) => s.entityPropertiesError);
  const explorerSelection = useAppStore((s) => s.explorerSelection);
  const refreshEntityProperties = useAppStore((s) => s.refreshEntityProperties);

  // Determine the display name for the header
  const entityName =
    explorerSelection.kind === "queue"
      ? explorerSelection.queueName
        : explorerSelection.kind === "subscription"
          ? `${explorerSelection.topicName} / ${explorerSelection.subscriptionName}`
          : null;
  const namespace = useMemo(() => conn ? extractNamespace(conn.connectionString) : null, [conn]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Header */}
      {entityName && (
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
              {entityName}
            </span>
            {entityProperties && (
              <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-azure-primary/10 text-azure-primary dark:bg-azure-primary/20">
                {entityTypeLabel(entityProperties, t)}
              </span>
            )}
          </div>
          {namespace && (
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 selectable">
              <span className="font-medium">{t("explorer.properties.namespace")}:</span> {namespace}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      {entityPropertiesLoading ? (
        <DetailsSkeleton />
      ) : entityPropertiesError ? (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-red-500 dark:text-red-400 mb-2">{t("explorer.entityDetails.error")}</p>
          <button
            onClick={refreshEntityProperties}
            className="text-xs text-azure-primary hover:underline"
          >
            {t("explorer.entityDetails.retry")}
          </button>
        </div>
      ) : entityProperties ? (
        <EntityDetailsContent props={entityProperties} />
      ) : null}
    </div>
  );
}
