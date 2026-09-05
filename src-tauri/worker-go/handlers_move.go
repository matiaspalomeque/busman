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

// ─── 4. moveMessages ─────────────────────────────────────────────────────────

type moveMessagesParams struct {
	SourceQueue     string            `json:"sourceQueue"`
	DestQueue       string            `json:"destQueue"`
	DestinationKind string            `json:"destinationKind"`
	Mode            string            `json:"mode"`
	Env             map[string]string `json:"env"`
	RunID           string            `json:"runId"`
	subscriptionSource
}

type messageDestinationKind string

const (
	messageDestinationQueue messageDestinationKind = "queue"
	messageDestinationTopic messageDestinationKind = "topic"
)

type messageDestination struct {
	Name string
	Kind messageDestinationKind
}

func (p moveMessagesParams) destination() (messageDestination, error) {
	switch p.DestinationKind {
	case "", string(messageDestinationQueue):
		return messageDestination{Name: p.DestQueue, Kind: messageDestinationQueue}, nil
	case string(messageDestinationTopic):
		return messageDestination{Name: p.DestQueue, Kind: messageDestinationTopic}, nil
	default:
		return messageDestination{}, fmt.Errorf("invalid destination kind %q: must be queue or topic", p.DestinationKind)
	}
}

func validateMoveSourceDest(sourceQueue, destQueue, mode string, isSubscription bool) error {
	// When source is a subscription, source and dest are always different entity types.
	if isSubscription {
		return nil
	}
	// DLQ re-drive back into the same queue is valid because source (DLQ) and destination (main) are different subqueues.
	if sourceQueue == destQueue && mode != "dlq" {
		return fmt.Errorf("source and destination queues must be different when mode is normal or both")
	}
	return nil
}

func resolveDrainReceiveWaitMs(env map[string]string, maxWaitMs int) int {
	drainWaitMs := parseIntOrDefault(env["DRAIN_IDLE_WAIT_TIME_IN_MS"], 3000)
	if drainWaitMs > maxWaitMs {
		return maxWaitMs
	}
	return drainWaitMs
}

func handleMoveMessages(requestCtx context.Context, raw json.RawMessage) (any, error) {
	var p moveMessagesParams
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
	destination, err := p.destination()
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
		if err := validateEntityName(p.SourceQueue, "Source queue"); err != nil {
			return nil, err
		}
	}
	destinationLabel := "Destination queue"
	if destination.Kind == messageDestinationTopic {
		destinationLabel = "Destination topic"
		if !p.isSubscription() || mode != "dlq" {
			return nil, fmt.Errorf("topic destinations are only supported when republishing a subscription dead-letter queue")
		}
	}
	if err := validateEntityName(destination.Name, destinationLabel); err != nil {
		return nil, err
	}
	if err := validateMoveSourceDest(p.SourceQueue, p.DestQueue, mode, p.isSubscription()); err != nil {
		return nil, err
	}

	batchSize := boundedIntFromEnv(p.Env, "RECEIVE_MESSAGES_COUNT", 50, maxReceiveBatchSize)
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 5000)
	drainWaitMs := resolveDrainReceiveWaitMs(p.Env, maxWaitMs)
	moveProgressIntervalMs := parseIntOrDefault(p.Env["MOVE_PROGRESS_INTERVAL_MS"], 500)
	if moveProgressIntervalMs < 50 {
		moveProgressIntervalMs = 50
	}
	completeConcurrency := parseIntOrDefault(p.Env["COMPLETE_CONCURRENCY"], 8)
	if completeConcurrency < 1 {
		completeConcurrency = 1
	}
	if completeConcurrency > 32 {
		completeConcurrency = 32
	}
	startedAt := time.Now()

	sessionCheckCtx, sessionCheckCancel := cancellableOperationContext(requestCtx, p.Env, defaultOperationTimeoutMs)
	requiresSession, err := sourceRequiresSession(sessionCheckCtx, cs, p.SourceQueue, p.subscriptionSource)
	sessionCheckCancel()
	if err != nil {
		return nil, fmt.Errorf("cannot safely move messages from %s because its session configuration could not be read: %w", p.label(p.SourceQueue), err)
	}

	duplicateDetectionCtx, duplicateDetectionCancel := cancellableOperationContext(requestCtx, p.Env, defaultOperationTimeoutMs)
	sendPolicy, err := inspectDestinationPolicy(duplicateDetectionCtx, cs, destination)
	duplicateDetectionCancel()
	if err != nil {
		return nil, fmt.Errorf(
			"cannot safely move messages to %s %q because its duplicate-detection configuration could not be read; no source messages were received or completed: %w",
			destination.Kind,
			destination.Name,
			err,
		)
	}
	if sendPolicy.RequiresDuplicateDetection {
		emitOutput(p.RunID,
			fmt.Sprintf("ℹ Destination %q uses duplicate detection; each moved message will receive a new MessageId and retain its original in BusmanOriginalMessageId.", destination.Name),
			false, elapsedSince(startedAt))
	}

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer closeWithTimeout(client)

	sender, err := client.NewSender(destination.Name, nil)
	if err != nil {
		return nil, fmt.Errorf("sender error: %w", err)
	}
	defer closeWithTimeout(sender)

	grandTotal := 0

	runOne := func(receiver destructiveMessageReceiver, queueType string, sourceMode string, settlementConcurrency int) (int, error) {
		totalMoved := 0
		stageStart := time.Now()
		lastProgressEmitAt := time.Time{}

		for {
			receiveWaitMs := maxWaitMs
			if totalMoved > 0 {
				receiveWaitMs = drainWaitMs
			}
			ctx, cancel := context.WithTimeout(requestCtx, time.Duration(receiveWaitMs)*time.Millisecond)
			messages, recvErr := receiver.ReceiveMessages(ctx, batchSize, nil)
			cancel()

			if recvErr != nil && len(messages) == 0 {
				if requestCtx.Err() != nil {
					return totalMoved, requestCtx.Err()
				}
				if errors.Is(recvErr, context.DeadlineExceeded) || errors.Is(recvErr, context.Canceled) {
					emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
					break
				}
				return totalMoved, fmt.Errorf("receive error: %w", recvErr)
			}
			if len(messages) == 0 {
				emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
				break
			}

			sendAndCompleteBatch := func(
				outboundBatch *azservicebus.MessageBatch,
				sourceMessages []*azservicebus.ReceivedMessage,
			) (int, error) {
				if outboundBatch.NumMessages() == 0 {
					return 0, nil
				}
				sendCtx, sendCancel := cancellableOperationContext(requestCtx, p.Env, defaultOperationTimeoutMs)
				defer sendCancel()
				recordOperation(requestCtx, sourceMode, 0, 0, len(sourceMessages), 0)
				if err := sender.SendMessageBatch(sendCtx, outboundBatch, nil); err != nil {
					return 0, fmt.Errorf("send message batch error: %w", err)
				}
				recordOperation(requestCtx, sourceMode, len(sourceMessages), 0, -len(sourceMessages), len(sourceMessages))
				confirmed, err := completeReceivedMessages(
					requestCtx,
					receiver,
					sourceMessages,
					p.Env,
					defaultOperationTimeoutMs,
					settlementConcurrency,
				)
				recordOperation(requestCtx, sourceMode, 0, confirmed, 0, -confirmed)
				if err != nil {
					failure := fmt.Errorf(
						"destination accepted %d messages but source settlement failed; duplicate delivery is possible: %w",
						outboundBatch.NumMessages(),
						err,
					)
					emitOutput(p.RunID, "⚠ "+failure.Error(), true, elapsedSince(startedAt))
					return confirmed, failure
				}
				return confirmed, nil
			}

			confirmed, err := sendMessagesInCompatibleBatches(
				messages,
				sendPolicy,
				func() (*azservicebus.MessageBatch, error) {
					batchCtx, batchCancel := cancellableOperationContext(requestCtx, p.Env, defaultOperationTimeoutMs)
					defer batchCancel()
					return sender.NewMessageBatch(batchCtx, nil)
				},
				sendAndCompleteBatch,
			)
			totalMoved += confirmed
			if err != nil {
				return totalMoved, fmt.Errorf("move stopped after %d confirmed messages: %w", totalMoved, err)
			}

			stageMs := time.Since(stageStart).Milliseconds()
			overallRate := calculateRate(totalMoved, stageMs)
			progress := fmt.Sprintf("📦 Moved: %d | Avg Rate: %d msg/s",
				totalMoved, overallRate)
			now := time.Now()
			if lastProgressEmitAt.IsZero() ||
				now.Sub(lastProgressEmitAt) >= time.Duration(moveProgressIntervalMs)*time.Millisecond {
				emitProgress(p.RunID, progress, elapsedSince(startedAt))
				lastProgressEmitAt = now
			}
		}

		emitOutput(p.RunID,
			fmt.Sprintf("✅ Finished %s. Total moved: %d in %.1fs",
				queueType, totalMoved, time.Since(stageStart).Seconds()),
			false, elapsedSince(startedAt))
		return totalMoved, nil
	}

	type moveResult struct {
		moved int
		err   error
	}

	newSourceReceiver := func(opts *azservicebus.ReceiverOptions) (*azservicebus.Receiver, error) {
		if p.isSubscription() {
			return client.NewReceiverForSubscription(p.TopicName, p.SubscriptionName, opts)
		}
		return client.NewReceiverForQueue(p.SourceQueue, opts)
	}
	runSource := func(subQueue azservicebus.SubQueue, label string) (int, error) {
		sourceMode := "normal"
		if subQueue != 0 {
			sourceMode = "dlq"
		}
		if requiresSession {
			return consumeAvailableSessions(
				requestCtx,
				maxWaitMs,
				drainWaitMs,
				label,
				func(ctx context.Context) (managedSessionReceiver, error) {
					return acceptNextSessionForSource(ctx, client, p.SourceQueue, p.subscriptionSource, subQueue)
				},
				func(receiver managedSessionReceiver, sessionLabel string) (int, error) {
					// Keep receive, send, and source settlement ordered within one session.
					return runOne(receiver, sessionLabel, sourceMode, 1)
				},
			)
		}

		var opts *azservicebus.ReceiverOptions
		if subQueue != 0 {
			opts = &azservicebus.ReceiverOptions{SubQueue: subQueue}
		}
		receiver, err := newSourceReceiver(opts)
		if err != nil {
			return 0, err
		}
		defer closeWithTimeout(receiver)
		return runOne(receiver, label, sourceMode, completeConcurrency)
	}

	entityKind := "queue"
	if p.isSubscription() {
		entityKind = "subscription"
	}

	if mode != "both" {
		label := "normal " + entityKind + ": " + p.label(p.SourceQueue)
		subQueue := azservicebus.SubQueue(0)
		if mode == "dlq" {
			label = "dead letter " + entityKind + ": " + p.label(p.SourceQueue)
			subQueue = azservicebus.SubQueueDeadLetter
		}
		moved, err := runSource(subQueue, label)
		if err != nil {
			if moved > 0 {
				emitOutput(p.RunID,
					fmt.Sprintf("⚠ Operation stopped after %d messages were confirmed moved.", moved),
					true, elapsedSince(startedAt))
			}
			return nil, err
		}
		grandTotal = moved
	} else {
		results := make(chan moveResult, 2)
		var wg sync.WaitGroup

		wg.Add(1)
		go func() {
			defer wg.Done()
			moved, err := runSource(0, "normal "+entityKind+": "+p.label(p.SourceQueue))
			results <- moveResult{moved: moved, err: err}
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			moved, err := runSource(azservicebus.SubQueueDeadLetter, "dead letter "+entityKind+": "+p.label(p.SourceQueue))
			results <- moveResult{moved: moved, err: err}
		}()

		go func() { wg.Wait(); close(results) }()

		var firstErr error
		for r := range results {
			if r.err != nil && firstErr == nil {
				firstErr = r.err
			}
			grandTotal += r.moved
		}
		if firstErr != nil {
			if grandTotal > 0 {
				emitOutput(p.RunID,
					fmt.Sprintf("⚠ Operation stopped after %d messages were confirmed moved.", grandTotal),
					true, elapsedSince(startedAt))
			}
			return nil, fmt.Errorf("move operation partially completed: %d messages confirmed moved: %w", grandTotal, firstErr)
		}
	}

	return map[string]int{"totalMoved": grandTotal}, nil
}

type republishSubscriptionDlqParams struct {
	TopicName        string            `json:"topicName"`
	SubscriptionName string            `json:"subscriptionName"`
	Env              map[string]string `json:"env"`
	RunID            string            `json:"runId"`
}

func handleRepublishSubscriptionDlq(requestCtx context.Context, raw json.RawMessage) (any, error) {
	var p republishSubscriptionDlqParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	if err := validateEntityName(p.TopicName, "Topic"); err != nil {
		return nil, err
	}
	if err := validateEntityName(p.SubscriptionName, "Subscription"); err != nil {
		return nil, err
	}

	moveRaw, err := json.Marshal(moveMessagesParams{
		DestQueue:       p.TopicName,
		DestinationKind: string(messageDestinationTopic),
		Mode:            "dlq",
		Env:             p.Env,
		RunID:           p.RunID,
		subscriptionSource: subscriptionSource{
			TopicName:        p.TopicName,
			SubscriptionName: p.SubscriptionName,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal republish params: %w", err)
	}
	return handleMoveMessages(requestCtx, moveRaw)
}
