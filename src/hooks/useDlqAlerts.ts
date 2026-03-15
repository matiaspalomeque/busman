import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";

/**
 * Monitors DLQ counts against configured thresholds and sends desktop
 * notifications when a threshold is breached. Notifications are sent at most
 * once per entity per threshold crossing per session (cleared on connection
 * change). The hook is side-effect only — it returns nothing.
 */
export function useDlqAlerts() {
  const entityCounts = useAppStore((s) => s.entityCounts);
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
    if (!entityCounts || !dlqNotificationsEnabled || Object.keys(dlqThresholds).length === 0) return;

    const breaches: { key: string; name: string; dlq: number; threshold: number }[] = [];

    for (const q of entityCounts.queues) {
      const key = `queue:${q.name}`;
      const threshold = dlqThresholds[key];
      if (threshold != null && q.dlq > threshold && !notifiedRef.current.has(key)) {
        breaches.push({ key, name: q.name, dlq: q.dlq, threshold });
      }
      if (threshold != null && q.dlq <= threshold) {
        notifiedRef.current.delete(key);
      }
    }

    for (const s of entityCounts.subscriptions) {
      const key = `subscription:${s.topic}\0${s.subscription}`;
      const threshold = dlqThresholds[key];
      if (threshold != null && s.dlq > threshold && !notifiedRef.current.has(key)) {
        breaches.push({ key, name: `${s.topic}/${s.subscription}`, dlq: s.dlq, threshold });
      }
      if (threshold != null && s.dlq <= threshold) {
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
  }, [entityCounts, dlqThresholds, dlqNotificationsEnabled]);
}
