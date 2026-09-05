# Message operations and recovery

Browse is non-destructive. It loads a local view; filters search only those loaded messages. The view retains at most 5,000 messages and 64 MiB of serialized payload. Actual process memory can be higher because parsed objects, rendering, and search text also occupy memory. A visible notice identifies truncated results. Clear releases the loaded view. Cursors advance only through retained messages.

Move captures the connection and source when its dialog opens, starts from the explorer's Normal/DLQ/Both selection, and shows its destination and bulk scope. Changing connections disables the captured dialog. Bulk operations consume all available messages until the source has been idle for the configured receive interval; the browse count and grid filters do not limit them. Drain / delete messages permanently removes source messages.

## Lifecycle

1. The frontend registers listeners, records metadata, and locks conflicting operations before dispatch.
2. Rust resolves the captured connection's credentials and dispatches through worker protocol v2.
3. Go owns the cancellable run and emits a heartbeat every five seconds, including while waiting for a handler slot. Structured progress aggregates Normal and DLQ work.
4. Stop requests cancellation. The interface stays locked until a terminal response or event arrives. A rejected stop is visible and does not pretend the run stopped.
5. The command response and completion event each carry terminal acknowledgment. Either can finish the frontend lifecycle. After 90 seconds without updates, the interface reports unknown observation and retains the lock. There is no absolute duration limit on healthy transfers. Single-message ownership and Stop controls remain available after navigation; the same message cannot be submitted twice while its first operation is pending.

Per-call broker timeouts and worker process/framing failures are separate from frontend observation. A worker transport failure or unconfirmed broker acknowledgment is an unknown outcome, not a confirmed failure with zero effects.

## Interpreting results

| Result field | Meaning |
|---|---|
| Confirmed sent | The destination acknowledged acceptance |
| Removed | The source acknowledged completion |
| Unconfirmed sends | Upper bound on sends whose acceptance was not confirmed |
| Unconfirmed removals | Upper bound on the received batch whose removal was not confirmed |
| Sources | Separate Normal/DLQ totals, summed for the whole run |

These are not exactly-once guarantees. Destination acceptance can succeed before source completion fails. An unconfirmed batch can include messages that were never settled as well as messages whose acknowledgment was lost. A cancellation with unconfirmed work remains **Outcome unknown**. [Azure settlement behavior](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-transfers-locks-settlement) explains why completing work and receiving its acknowledgment are distinct.

The Event Log retains up to 500 metadata entries for 30 days in local application storage. It includes captured scope, progress checkpoints at most every five seconds, and terminal counts, excludes message bodies, credentials, raw request parameters, and free-form error text, and can be exported as JSON. A save failure is visible. Local history can be lost if application storage is cleared; export it when needed for an incident.

### Messages that return after a resend

Single-message resends record delivery separately from processing. A successful resend shows **Resent**, with processing still unverified. When Browse or Load More observes that attempt back in the dead-letter queue, its history entry and message details show **Resent successfully, but processing failed again**. The collapsed Event Log also exposes the return. The original send result remains successful, and the observation time and returned sequence number are retained with the operation history.

Detection applies to new single-message replay attempts, including the detail-panel Resend action. The worker writes the attempt's identifier to the `BusmanReplayRunId` application property, replacing any earlier attempt's marker. The marker must survive processing. Detection requires the matching local history entry, the same saved connection and source queue or subscription, and an observed dead-letter message. Bulk replay and Send a copy are not tracked. Queue-count refreshes do not inspect message content. Messages outside the browsed results, stripped markers, expired history, and older resends cannot be confirmed by this feature; absence never proves successful processing. No automatic retry is performed.

A checkpoint is the last observed count, not a final total. Work after that observation may be missing. An interrupted journal entry is restored as **Outcome unknown**. Inspect the source and destination using message IDs, sequence numbers, and application context before retrying. Mark **I checked the broker** in Event Log only after that review; the original unknown outcome remains recorded with the review time. New destructive message operations against that connection remain blocked until acknowledgment. Busman never automatically resends or resumes an uncertain batch.

If both completion transports are lost, try Stop. If the worker can no longer acknowledge the run, export the history, close and reopen Busman, then reconcile the restored unknown entry. Restarting is not proof of what happened at the broker.
