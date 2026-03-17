import { useEffect, useRef } from "react";
import { useAppStore, SUBSCRIPTION_KEY_SEP } from "../store/appStore";

/**
 * Monitors DLQ counts against configured thresholds and sends desktop
 * notifications when a threshold is breached. Notifications are sent at most
 * once per entity per threshold crossing per session (cleared on connection
 * change). The hook is side-effect only — it returns nothing.
 */
export function useDlqAlerts() {
  const queueCounts = useAppStore((s) => s.queueCounts);
  const subscriptionCounts = useAppStore((s) => s.subscriptionCounts);
  const dlqThresholds = useAppStore((s) => s.dlqThresholds);
  const dlqNotificationsEnabled = useAppStore((s) => s.dlqNotificationsEnabled);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const notifiedRef = useRef(new Set<string>());

  // Clear notified set on connection change
  useEffect(() => {
    notifiedRef.current = new Set();
  }, [activeConnectionId]);

  // Check thresholds when counts update
  useEffect(() => {
    if (!dlqNotificationsEnabled || Object.keys(dlqThresholds).length === 0) return;

    const breaches: { key: string; name: string; dlq: number; threshold: number }[] = [];

    for (const [name, counts] of Object.entries(queueCounts)) {
      const key = `queue:${name}`;
      const threshold = dlqThresholds[key];
      if (threshold != null && counts.dlq > threshold && !notifiedRef.current.has(key)) {
        breaches.push({ key, name, dlq: counts.dlq, threshold });
      }
      if (threshold != null && counts.dlq <= threshold) {
        notifiedRef.current.delete(key);
      }
    }

    // subscriptionCounts key is "topic\0subscription"; dlqThresholds key is "subscription:topic\0subscription"
    for (const [subKey, counts] of Object.entries(subscriptionCounts)) {
      const key = `subscription:${subKey}`;
      const threshold = dlqThresholds[key];
      const displayName = subKey.replace(SUBSCRIPTION_KEY_SEP, "/");
      if (threshold != null && counts.dlq > threshold && !notifiedRef.current.has(key)) {
        breaches.push({ key, name: displayName, dlq: counts.dlq, threshold });
      }
      if (threshold != null && counts.dlq <= threshold) {
        notifiedRef.current.delete(key);
      }
    }

    if (breaches.length === 0) return;

    // Dynamic import to avoid loading notification plugin when not needed
    void (async () => {
      try {
        const { isPermissionGranted, requestPermission, sendNotification } = await import(
          "@tauri-apps/plugin-notification"
        );
        let permitted = await isPermissionGranted();
        if (!permitted) {
          const result = await requestPermission();
          permitted = result === "granted";
        }
        if (!permitted) return;

        for (const b of breaches) {
          sendNotification({
            title: "DLQ Threshold Alert",
            body: `${b.name}: ${b.dlq} DLQ messages (threshold: ${b.threshold})`,
          });
          notifiedRef.current.add(b.key);
        }
      } catch {
        // Notification plugin not available — silently skip
      }
    })();
  }, [queueCounts, subscriptionCounts, dlqThresholds, dlqNotificationsEnabled]);
}
