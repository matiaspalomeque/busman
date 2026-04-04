import { useEffect, useRef } from "react";
import { useAppStore, selectActiveConnection } from "../store/appStore";
import { safeInvoke, QueuePropertiesSchema, SubscriptionPropertiesSchema } from "../schemas/ipc";

export function useEntityProperties() {
  const conn = useAppStore(selectActiveConnection);
  const explorerSelection = useAppStore((s) => s.explorerSelection);
  const requestNonce = useAppStore((s) => s.entityPropertiesRequestNonce);
  const { setEntityPropertiesState } = useAppStore();

  const fetchIdRef = useRef(0);

  useEffect(() => {
    const currentFetchId = ++fetchIdRef.current;
    const isStale = () => fetchIdRef.current !== currentFetchId;
    const invalidateCurrentFetch = () => {
      if (fetchIdRef.current === currentFetchId) {
        fetchIdRef.current += 1;
      }
    };

    const connId = conn?.id;
    if (!connId || explorerSelection.kind === "none") {
      setEntityPropertiesState(null, false, null);
      return invalidateCurrentFetch;
    }

    setEntityPropertiesState(null, true, null);

    const fetchProperties = async () => {
      try {
        if (explorerSelection.kind === "queue") {
          const data = await safeInvoke(
            "get_queue_properties",
            QueuePropertiesSchema,
            { args: { connectionId: connId, queueName: explorerSelection.queueName } }
          );
          if (isStale()) return;
          setEntityPropertiesState({ kind: "queue", data }, false, null);
        } else if (explorerSelection.kind === "subscription") {
          const data = await safeInvoke(
            "get_subscription_properties",
            SubscriptionPropertiesSchema,
            {
              args: {
                connectionId: connId,
                topicName: explorerSelection.topicName,
                subscriptionName: explorerSelection.subscriptionName,
              },
            }
          );
          if (isStale()) return;
          setEntityPropertiesState({ kind: "subscription", data }, false, null);
        }
      } catch (err) {
        if (isStale()) return;
        setEntityPropertiesState(null, false, String(err));
      }
    };

    void fetchProperties();
    return invalidateCurrentFetch;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conn?.id,
    explorerSelection.kind,
    explorerSelection.queueName,
    explorerSelection.topicName,
    explorerSelection.subscriptionName,
    requestNonce,
  ]);
}
