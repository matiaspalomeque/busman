package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

// ─── 3. emptyMessages ────────────────────────────────────────────────────────

type emptyMessagesParams struct {
	QueueName string            `json:"queueName"`
	Mode      string            `json:"mode"`
	Env       map[string]string `json:"env"`
	RunID     string            `json:"runId"`
	subscriptionSource
}

func handleEmptyMessages(requestCtx context.Context, raw json.RawMessage) (any, error) {
	var p emptyMessagesParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	mode, err := validateMode(p.Mode, "both")
	if err != nil {
		return nil, err
	}
	if p.isSubscription() {
		if err := validateEntityName(p.TopicName, "Topic"); err != nil {
			return nil, err
		}
		if err := validateEntityName(p.SubscriptionName, "Subscription"); err != nil {
			return nil, err
		}
	} else {
		if err := validateEntityName(p.QueueName, "Queue"); err != nil {
			return nil, err
		}
	}

	batchSize := boundedIntFromEnv(p.Env, "RECEIVE_MESSAGES_COUNT", 50, maxReceiveBatchSize)
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 5000)
	drainWaitMs := resolveDrainReceiveWaitMs(p.Env, maxWaitMs)
	emptyProgressIntervalMs := parseIntOrDefault(p.Env["EMPTY_PROGRESS_INTERVAL_MS"], 1000)
	if emptyProgressIntervalMs < 50 {
		emptyProgressIntervalMs = 50
	}
	completeConcurrency := parseIntOrDefault(p.Env["COMPLETE_CONCURRENCY"], 8)
	if completeConcurrency < 1 {
		completeConcurrency = 1
	}
	if completeConcurrency > 32 {
		completeConcurrency = 32
	}
	startedAt := time.Now()

	sessionCheckCtx, sessionCheckCancel := cancellableOperationContext(requestCtx, p.Env, maxWaitMs)
	requiresSession, err := sourceRequiresSession(sessionCheckCtx, cs, p.QueueName, p.subscriptionSource)
	sessionCheckCancel()
	if err != nil {
		return nil, fmt.Errorf("cannot safely empty %s because its session configuration could not be read: %w", p.label(p.QueueName), err)
	}

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer closeWithTimeout(client)

	grandTotal := 0

	runOne := func(receiver destructiveMessageReceiver, queueType string, settlementConcurrency int) (int, error) {
		totalDeleted := 0
		stageStart := time.Now()
		lastProgressEmitAt := time.Time{}

		emitOutput(p.RunID, "🚀 Starting to empty "+queueType+"...", false, elapsedSince(startedAt))
		emitOutput(p.RunID, fmt.Sprintf("   Batch size: %d, First wait: %dms, Drain wait: %dms", batchSize, maxWaitMs, drainWaitMs), false, elapsedSince(startedAt))

		for {
			receiveWaitMs := maxWaitMs
			if totalDeleted > 0 {
				receiveWaitMs = drainWaitMs
			}
			ctx, cancel := context.WithTimeout(requestCtx, time.Duration(receiveWaitMs)*time.Millisecond)
			messages, recvErr := receiver.ReceiveMessages(ctx, batchSize, nil)
			cancel()

			if recvErr != nil && len(messages) == 0 {
				if requestCtx.Err() != nil {
					return totalDeleted, requestCtx.Err()
				}
				if errors.Is(recvErr, context.DeadlineExceeded) || errors.Is(recvErr, context.Canceled) {
					emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
					break
				}
				return totalDeleted, fmt.Errorf("receive error: %w", recvErr)
			}
			if len(messages) == 0 {
				emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
				break
			}

			completed, err := completeReceivedMessages(
				requestCtx,
				receiver,
				messages,
				p.Env,
				maxWaitMs,
				settlementConcurrency,
			)
			totalDeleted += completed
			if err != nil {
				return totalDeleted, err
			}

			stageMs := time.Since(stageStart).Milliseconds()
			overallRate := calculateRate(totalDeleted, stageMs)
			progress := fmt.Sprintf("🗑️ Deleted: %d | Avg Rate: %d msg/s",
				totalDeleted, overallRate)
			now := time.Now()
			if lastProgressEmitAt.IsZero() ||
				now.Sub(lastProgressEmitAt) >= time.Duration(emptyProgressIntervalMs)*time.Millisecond {
				emitProgress(p.RunID, progress, elapsedSince(startedAt))
				lastProgressEmitAt = now
			}
		}

		emitOutput(p.RunID,
			fmt.Sprintf("✅ Finished %s. Total deleted: %d in %.1fs",
				queueType, totalDeleted, time.Since(stageStart).Seconds()),
			false, elapsedSince(startedAt))
		return totalDeleted, nil
	}

	type emptyResult struct {
		deleted int
		err     error
	}

	newReceiver := func(opts *azservicebus.ReceiverOptions) (*azservicebus.Receiver, error) {
		if p.isSubscription() {
			return client.NewReceiverForSubscription(p.TopicName, p.SubscriptionName, opts)
		}
		return client.NewReceiverForQueue(p.QueueName, opts)
	}
	runSource := func(subQueue azservicebus.SubQueue, label string) (int, error) {
		if requiresSession {
			return consumeAvailableSessions(
				requestCtx,
				maxWaitMs,
				drainWaitMs,
				label,
				func(ctx context.Context) (managedSessionReceiver, error) {
					return acceptNextSessionForSource(ctx, client, p.QueueName, p.subscriptionSource, subQueue)
				},
				func(receiver managedSessionReceiver, sessionLabel string) (int, error) {
					// Session messages are settled in receive order.
					return runOne(receiver, sessionLabel, 1)
				},
			)
		}

		var opts *azservicebus.ReceiverOptions
		if subQueue != 0 {
			opts = &azservicebus.ReceiverOptions{SubQueue: subQueue}
		}
		receiver, err := newReceiver(opts)
		if err != nil {
			return 0, err
		}
		defer closeWithTimeout(receiver)
		return runOne(receiver, label, completeConcurrency)
	}

	entityKind := "queue"
	if p.isSubscription() {
		entityKind = "subscription"
	}

	if mode != "both" {
		label := "normal " + entityKind + ": " + p.label(p.QueueName)
		subQueue := azservicebus.SubQueue(0)
		if mode == "dlq" {
			label = "dead letter " + entityKind + ": " + p.label(p.QueueName)
			subQueue = azservicebus.SubQueueDeadLetter
		}
		deleted, err := runSource(subQueue, label)
		if err != nil {
			if deleted > 0 {
				emitOutput(p.RunID,
					fmt.Sprintf("⚠ Operation stopped after %d messages were confirmed deleted.", deleted),
					true, elapsedSince(startedAt))
			}
			return nil, err
		}
		grandTotal = deleted
	} else {
		results := make(chan emptyResult, 2)
		var wg sync.WaitGroup

		wg.Add(1)
		go func() {
			defer wg.Done()
			deleted, err := runSource(0, "normal "+entityKind+": "+p.label(p.QueueName))
			results <- emptyResult{deleted: deleted, err: err}
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			deleted, err := runSource(azservicebus.SubQueueDeadLetter, "dead letter "+entityKind+": "+p.label(p.QueueName))
			results <- emptyResult{deleted: deleted, err: err}
		}()

		go func() { wg.Wait(); close(results) }()

		var firstErr error
		for r := range results {
			if r.err != nil && firstErr == nil {
				firstErr = r.err
			}
			grandTotal += r.deleted
		}
		if firstErr != nil {
			if grandTotal > 0 {
				emitOutput(p.RunID,
					fmt.Sprintf("⚠ Operation stopped after %d messages were confirmed deleted.", grandTotal),
					true, elapsedSince(startedAt))
			}
			return nil, fmt.Errorf("empty operation stopped after deleting %d messages: %w", grandTotal, firstErr)
		}
	}

	return map[string]int{"totalDeleted": grandTotal}, nil
}
