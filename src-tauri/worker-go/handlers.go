package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

// ─── Shared validation / parsing helpers ─────────────────────────────────────

const entityNameMaxLen = 260

var entityNameRe = regexp.MustCompile(`^[a-zA-Z0-9._\-/]+$`)

func requireConnectionString(env map[string]string) (string, error) {
	cs := env["SERVICE_BUS_CONNECTION_STRING"]
	if cs == "" {
		return "", fmt.Errorf("SERVICE_BUS_CONNECTION_STRING environment variable is required")
	}
	return cs, nil
}

func validateEntityName(name, label string) error {
	if name == "" {
		return fmt.Errorf("%s name is required", label)
	}
	if len(name) > entityNameMaxLen {
		return fmt.Errorf("%s name must be %d characters or less", label, entityNameMaxLen)
	}
	if !entityNameRe.MatchString(name) {
		return fmt.Errorf("%s name contains invalid characters. Allowed: alphanumeric, dot, underscore, hyphen, slash", label)
	}
	return nil
}

// validateMode normalises mode; defaultVal is used when mode == "".
func validateMode(mode, defaultVal string) (string, error) {
	if mode == "" {
		mode = defaultVal
	}
	mode = strings.ToLower(mode)
	switch mode {
	case "normal", "dlq", "both":
		return mode, nil
	default:
		return "", fmt.Errorf(`invalid mode. Use "normal", "dlq", or "both"`)
	}
}

func parseIntOrDefault(s string, def int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil || v <= 0 {
		return def
	}
	return v
}

func parseBoolOrDefault(s string, def bool) bool {
	if s == "" {
		return def
	}
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}

func anyToIntOrDefault(v any, def int) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case string:
		return parseIntOrDefault(t, def)
	}
	return def
}

func calculateRate(count int, durationMs int64) int {
	if durationMs <= 0 {
		return 0
	}
	return int(math.Round(float64(count) / (float64(durationMs) / 1000.0)))
}

// bodyToJSON tries to decode as JSON and returns the value; falls back to string.
// This matches the JS SDK behaviour where AMQP-encoded messages arrive as parsed values.
func bodyToJSON(b []byte) any {
	if len(b) == 0 {
		return ""
	}
	var v any
	if err := json.Unmarshal(b, &v); err == nil {
		return v
	}
	return string(b)
}

func derefString(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func traceParent(props map[string]any) any {
	if props == nil {
		return nil
	}
	if v, ok := props["Diagnostic-Id"]; ok {
		return v
	}
	return nil
}

// ─── 2. listEntities ─────────────────────────────────────────────────────────

type listEntitiesParams struct {
	Env map[string]string `json:"env"`
}

func handleListEntities(raw json.RawMessage) (any, error) {
	var p listEntitiesParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
	}

	ctx := context.Background()
	queues := []string{}
	topics := map[string][]string{}

	queuePager := adminClient.NewListQueuesPager(nil)
	for queuePager.More() {
		page, err := queuePager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list queues error: %w", err)
		}
		for _, q := range page.Queues {
			queues = append(queues, q.QueueName)
		}
	}

	topicPager := adminClient.NewListTopicsPager(nil)
	for topicPager.More() {
		page, err := topicPager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list topics error: %w", err)
		}
		for _, t := range page.Topics {
			subs := []string{}
			subPager := adminClient.NewListSubscriptionsPager(t.TopicName, nil)
			for subPager.More() {
				subPage, err := subPager.NextPage(ctx)
				if err != nil {
					return nil, fmt.Errorf("list subscriptions error: %w", err)
				}
				for _, s := range subPage.Subscriptions {
					subs = append(subs, s.SubscriptionName)
				}
			}
			topics[t.TopicName] = subs
		}
	}

	return map[string]any{"queues": queues, "topics": topics}, nil
}

// ─── 2b. getEntityCounts ─────────────────────────────────────────────────────

type subscriptionRef struct {
	Topic string `json:"topic"`
	Name  string `json:"name"`
}

type entityCountsParams struct {
	Env           map[string]string `json:"env"`
	Queues        []string          `json:"queues"`
	Subscriptions []subscriptionRef `json:"subscriptions"`
}

type queueCountResult struct {
	Name   string `json:"name"`
	Active int64  `json:"active"`
	DLQ    int64  `json:"dlq"`
}

type subscriptionCountResult struct {
	Topic        string `json:"topic"`
	Subscription string `json:"subscription"`
	Active       int64  `json:"active"`
	DLQ          int64  `json:"dlq"`
}

func handleGetEntityCounts(raw json.RawMessage) (any, error) {
	var p entityCountsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
	}

	ctx := context.Background()
	const concurrency = 8

	sem := make(chan struct{}, concurrency)
	var mu sync.Mutex
	var wg sync.WaitGroup

	queueResults := make([]queueCountResult, 0, len(p.Queues))
	subResults := make([]subscriptionCountResult, 0, len(p.Subscriptions))

	for _, qName := range p.Queues {
		if err := validateEntityName(qName, "Queue"); err != nil {
			return nil, err
		}
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			var active, dlq int64
			if resp, err := adminClient.GetQueueRuntimeProperties(ctx, name, nil); err == nil {
				active = int64(resp.ActiveMessageCount)
				dlq = int64(resp.DeadLetterMessageCount)
			}
			mu.Lock()
			queueResults = append(queueResults, queueCountResult{Name: name, Active: active, DLQ: dlq})
			mu.Unlock()
		}(qName)
	}

	for _, sub := range p.Subscriptions {
		if err := validateEntityName(sub.Topic, "Topic"); err != nil {
			return nil, err
		}
		if err := validateEntityName(sub.Name, "Subscription"); err != nil {
			return nil, err
		}
		wg.Add(1)
		go func(topic, name string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			var active, dlq int64
			if resp, err := adminClient.GetSubscriptionRuntimeProperties(ctx, topic, name, nil); err == nil {
				active = int64(resp.ActiveMessageCount)
				dlq = int64(resp.DeadLetterMessageCount)
			}
			mu.Lock()
			subResults = append(subResults, subscriptionCountResult{Topic: topic, Subscription: name, Active: active, DLQ: dlq})
			mu.Unlock()
		}(sub.Topic, sub.Name)
	}

	wg.Wait()

	return map[string]any{
		"queues":        queueResults,
		"subscriptions": subResults,
	}, nil
}

// ─── 3. emptyMessages ────────────────────────────────────────────────────────

type emptyMessagesParams struct {
	QueueName string            `json:"queueName"`
	Mode      string            `json:"mode"`
	Env       map[string]string `json:"env"`
	RunID     string            `json:"runId"`
}

func handleEmptyMessages(raw json.RawMessage) (any, error) {
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
	if err := validateEntityName(p.QueueName, "Queue"); err != nil {
		return nil, err
	}

	batchSize := parseIntOrDefault(p.Env["RECEIVE_MESSAGES_COUNT"], 50)
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 5000)
	drainWaitMs := resolveDrainReceiveWaitMs(p.Env, maxWaitMs)
	emptyProgressIntervalMs := parseIntOrDefault(p.Env["EMPTY_PROGRESS_INTERVAL_MS"], 1000)
	if emptyProgressIntervalMs < 50 {
		emptyProgressIntervalMs = 50
	}
	completeConcurrency := parseIntOrDefault(p.Env["COMPLETE_CONCURRENCY"], 8)
	if completeConcurrency > 32 {
		completeConcurrency = 32
	}
	startedAt := time.Now()

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer client.Close(context.Background())

	grandTotal := 0

	runOne := func(receiver *azservicebus.Receiver, queueType string) (int, error) {
		defer receiver.Close(context.Background())
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
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(receiveWaitMs)*time.Millisecond)
			messages, recvErr := receiver.ReceiveMessages(ctx, batchSize, nil)
			cancel()

			if recvErr != nil && len(messages) == 0 {
				if errors.Is(recvErr, context.DeadlineExceeded) || errors.Is(recvErr, context.Canceled) {
					emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
					break
				}
				return 0, fmt.Errorf("receive error: %w", recvErr)
			}
			if len(messages) == 0 {
				emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
				break
			}

			// Complete messages in parallel with bounded concurrency.
			sem := make(chan struct{}, completeConcurrency)
			var wg sync.WaitGroup
			errCh := make(chan error, len(messages))
			for _, msg := range messages {
				wg.Add(1)
				go func(m *azservicebus.ReceivedMessage) {
					defer wg.Done()
					sem <- struct{}{}
					defer func() { <-sem }()
					if err := receiver.CompleteMessage(context.Background(), m, nil); err != nil {
						errCh <- fmt.Errorf("complete message error: %w", err)
					}
				}(msg)
			}
			wg.Wait()
			close(errCh)
			if err := <-errCh; err != nil {
				return 0, err
			}

			totalDeleted += len(messages)

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

	if mode != "both" {
		queueType := "normal queue"
		var opts *azservicebus.ReceiverOptions
		if mode == "dlq" {
			queueType = "dead letter queue"
			opts = &azservicebus.ReceiverOptions{SubQueue: azservicebus.SubQueueDeadLetter}
		}
		receiver, err := client.NewReceiverForQueue(p.QueueName, opts)
		if err != nil {
			return nil, err
		}
		deleted, err := runOne(receiver, queueType)
		if err != nil {
			return nil, err
		}
		grandTotal = deleted
	} else {
		results := make(chan emptyResult, 2)
		var wg sync.WaitGroup

		wg.Add(1)
		go func() {
			defer wg.Done()
			receiver, err := client.NewReceiverForQueue(p.QueueName, nil)
			if err != nil {
				results <- emptyResult{err: err}
				return
			}
			deleted, err := runOne(receiver, "normal queue")
			results <- emptyResult{deleted: deleted, err: err}
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			receiver, err := client.NewReceiverForQueue(p.QueueName,
				&azservicebus.ReceiverOptions{SubQueue: azservicebus.SubQueueDeadLetter})
			if err != nil {
				results <- emptyResult{err: err}
				return
			}
			deleted, err := runOne(receiver, "dead letter queue")
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
			return nil, firstErr
		}
	}

	return map[string]int{"totalDeleted": grandTotal}, nil
}

// ─── 4. moveMessages ─────────────────────────────────────────────────────────

type moveMessagesParams struct {
	SourceQueue string            `json:"sourceQueue"`
	DestQueue   string            `json:"destQueue"`
	Mode        string            `json:"mode"`
	Env         map[string]string `json:"env"`
	RunID       string            `json:"runId"`
}

func validateMoveSourceDest(sourceQueue, destQueue, mode string) error {
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

func handleMoveMessages(raw json.RawMessage) (any, error) {
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
	if err := validateEntityName(p.SourceQueue, "Source queue"); err != nil {
		return nil, err
	}
	if err := validateEntityName(p.DestQueue, "Destination queue"); err != nil {
		return nil, err
	}
	if err := validateMoveSourceDest(p.SourceQueue, p.DestQueue, mode); err != nil {
		return nil, err
	}

	batchSize := parseIntOrDefault(p.Env["RECEIVE_MESSAGES_COUNT"], 50)
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 5000)
	drainWaitMs := resolveDrainReceiveWaitMs(p.Env, maxWaitMs)
	moveProgressIntervalMs := parseIntOrDefault(p.Env["MOVE_PROGRESS_INTERVAL_MS"], 500)
	if moveProgressIntervalMs < 50 {
		moveProgressIntervalMs = 50
	}
	completeConcurrency := parseIntOrDefault(p.Env["COMPLETE_CONCURRENCY"], 8)
	if completeConcurrency > 32 {
		completeConcurrency = 32
	}
	startedAt := time.Now()

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer client.Close(context.Background())

	sender, err := client.NewSender(p.DestQueue, nil)
	if err != nil {
		return nil, fmt.Errorf("sender error: %w", err)
	}
	defer sender.Close(context.Background())

	grandTotal := 0

	runOne := func(receiver *azservicebus.Receiver, queueType string) (int, error) {
		defer receiver.Close(context.Background())
		totalMoved := 0
		stageStart := time.Now()
		lastProgressEmitAt := time.Time{}

		for {
			receiveWaitMs := maxWaitMs
			if totalMoved > 0 {
				receiveWaitMs = drainWaitMs
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(receiveWaitMs)*time.Millisecond)
			messages, recvErr := receiver.ReceiveMessages(ctx, batchSize, nil)
			cancel()

			if recvErr != nil && len(messages) == 0 {
				if errors.Is(recvErr, context.DeadlineExceeded) || errors.Is(recvErr, context.Canceled) {
					emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
					break
				}
				return 0, fmt.Errorf("receive error: %w", recvErr)
			}
			if len(messages) == 0 {
				emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
				break
			}

			sendAndCompleteBatch := func(
				outboundBatch *azservicebus.MessageBatch,
				sourceMessages []*azservicebus.ReceivedMessage,
			) error {
				if outboundBatch.NumMessages() == 0 {
					return nil
				}
				if err := sender.SendMessageBatch(context.Background(), outboundBatch, nil); err != nil {
					return fmt.Errorf("send message batch error: %w", err)
				}
				// Complete source messages in parallel with bounded concurrency.
				sem := make(chan struct{}, completeConcurrency)
				var wg sync.WaitGroup
				errCh := make(chan error, len(sourceMessages))
				for _, srcMsg := range sourceMessages {
					wg.Add(1)
					go func(msg *azservicebus.ReceivedMessage) {
						defer wg.Done()
						sem <- struct{}{}
						defer func() { <-sem }()
						if err := receiver.CompleteMessage(context.Background(), msg, nil); err != nil {
							errCh <- fmt.Errorf("complete message error: %w", err)
						}
					}(srcMsg)
				}
				wg.Wait()
				close(errCh)
				if err := <-errCh; err != nil {
					return err
				}
				return nil
			}

			outboundBatch, err := sender.NewMessageBatch(context.Background(), nil)
			if err != nil {
				return 0, fmt.Errorf("create message batch error: %w", err)
			}
			sourceMessagesForBatch := make([]*azservicebus.ReceivedMessage, 0, len(messages))

			for _, msg := range messages {
				newMsg := &azservicebus.Message{
					Body:                  msg.Body,
					ContentType:           msg.ContentType,
					CorrelationID:         msg.CorrelationID,
					Subject:               msg.Subject,
					ApplicationProperties: msg.ApplicationProperties,
					To:                    msg.To,
					ReplyTo:               msg.ReplyTo,
					SessionID:             msg.SessionID,
					TimeToLive:            msg.TimeToLive,
				}
				if msg.MessageID != "" {
					idCopy := msg.MessageID
					newMsg.MessageID = &idCopy
				}

				addErr := outboundBatch.AddMessage(newMsg, nil)
				if addErr != nil {
					if errors.Is(addErr, azservicebus.ErrMessageTooLarge) {
						// Flush the current batch and retry adding the large message in a fresh batch.
						if outboundBatch.NumMessages() == 0 {
							return 0, fmt.Errorf("send message error: message %q is too large for Service Bus batch", msg.MessageID)
						}
						if err := sendAndCompleteBatch(outboundBatch, sourceMessagesForBatch); err != nil {
							return 0, err
						}

						outboundBatch, err = sender.NewMessageBatch(context.Background(), nil)
						if err != nil {
							return 0, fmt.Errorf("create message batch error: %w", err)
						}
						sourceMessagesForBatch = sourceMessagesForBatch[:0]

						addErr = outboundBatch.AddMessage(newMsg, nil)
					}
					if addErr != nil {
						if errors.Is(addErr, azservicebus.ErrMessageTooLarge) {
							return 0, fmt.Errorf("send message error: message %q is too large for Service Bus batch", msg.MessageID)
						}
						return 0, fmt.Errorf("add message to batch error: %w", addErr)
					}
				}
				sourceMessagesForBatch = append(sourceMessagesForBatch, msg)
			}

			if err := sendAndCompleteBatch(outboundBatch, sourceMessagesForBatch); err != nil {
				return 0, err
			}
			totalMoved += len(messages)

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

	if mode != "both" {
		queueType := "normal queue"
		var opts *azservicebus.ReceiverOptions
		if mode == "dlq" {
			queueType = "dead letter queue"
			opts = &azservicebus.ReceiverOptions{SubQueue: azservicebus.SubQueueDeadLetter}
		}
		receiver, err := client.NewReceiverForQueue(p.SourceQueue, opts)
		if err != nil {
			return nil, err
		}
		moved, err := runOne(receiver, queueType)
		if err != nil {
			return nil, err
		}
		grandTotal = moved
	} else {
		results := make(chan moveResult, 2)
		var wg sync.WaitGroup

		wg.Add(1)
		go func() {
			defer wg.Done()
			receiver, err := client.NewReceiverForQueue(p.SourceQueue, nil)
			if err != nil {
				results <- moveResult{err: err}
				return
			}
			moved, err := runOne(receiver, "normal queue")
			results <- moveResult{moved: moved, err: err}
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			receiver, err := client.NewReceiverForQueue(p.SourceQueue,
				&azservicebus.ReceiverOptions{SubQueue: azservicebus.SubQueueDeadLetter})
			if err != nil {
				results <- moveResult{err: err}
				return
			}
			moved, err := runOne(receiver, "dead letter queue")
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
			return nil, firstErr
		}
	}

	return map[string]int{"totalMoved": grandTotal}, nil
}

// ─── 5. searchMessages ───────────────────────────────────────────────────────

type searchMessagesParams struct {
	QueueName    string            `json:"queueName"`
	SearchString string            `json:"searchString"`
	Mode         string            `json:"mode"`
	MaxMatches   any               `json:"maxMatches"`
	Env          map[string]string `json:"env"`
	RunID        string            `json:"runId"`
}

func handleSearchMessages(raw json.RawMessage) (any, error) {
	var p searchMessagesParams
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
	if err := validateEntityName(p.QueueName, "Queue"); err != nil {
		return nil, err
	}

	searchStr := strings.TrimSpace(p.SearchString)
	if searchStr == "" {
		return nil, fmt.Errorf("search string is required")
	}

	maxMatches := anyToIntOrDefault(p.MaxMatches, 50)
	if maxMatches < 1 {
		return nil, fmt.Errorf("max matches must be a positive integer")
	}

	batchSize := parseIntOrDefault(p.Env["BATCH_SIZE"], 50)
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 60000)
	caseSensitive := p.Env["CASE_SENSITIVE"] == "true"
	startedAt := time.Now()

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer client.Close(context.Background())

	grandChecked := 0
	grandMatches := 0
	reachedLimit := false

	searchLower := strings.ToLower(searchStr)

	runOne := func(receiver *azservicebus.Receiver, queueType string) error {
		defer receiver.Close(context.Background())
		if reachedLimit {
			return nil
		}

		totalChecked := 0
		matchesFound := 0
		var fromSequenceNumber *int64
		canAdvanceCursor := true
		stageStart := time.Now()

		emitOutput(p.RunID, "🔍 Searching "+queueType+"...", false, elapsedSince(startedAt))
		emitOutput(p.RunID,
			fmt.Sprintf(`   Looking for: "%s" (caseSensitive=%v) | Max matches: %d`,
				searchStr, caseSensitive, maxMatches),
			false, elapsedSince(startedAt))

		for {
			if reachedLimit {
				break
			}

			var opts *azservicebus.PeekMessagesOptions
			if fromSequenceNumber != nil {
				opts = &azservicebus.PeekMessagesOptions{FromSequenceNumber: fromSequenceNumber}
			}
			peekCtx, peekCancel := context.WithTimeout(context.Background(), time.Duration(maxWaitMs)*time.Millisecond)
			messages, err := receiver.PeekMessages(peekCtx, batchSize, opts)
			peekCancel()
			if err != nil {
				return fmt.Errorf("peek error: %w", err)
			}
			if len(messages) == 0 {
				emitOutput(p.RunID, "✨ No more messages found in "+queueType+".", false, elapsedSince(startedAt))
				break
			}

			for _, msg := range messages {
				totalChecked++
				body := string(msg.Body)
				var contains bool
				if caseSensitive {
					contains = strings.Contains(body, searchStr)
				} else {
					contains = strings.Contains(strings.ToLower(body), searchLower)
				}

				if contains {
					matchesFound++
					grandMatches++
					matchRecord := map[string]any{
						"messageId":                  msg.MessageID,
						"sequenceNumber":             msg.SequenceNumber,
						"body":                       bodyToJSON(msg.Body),
						"subject":                    derefString(msg.Subject),
						"contentType":                derefString(msg.ContentType),
						"correlationId":              derefString(msg.CorrelationID),
						"partitionKey":               derefString(msg.PartitionKey),
						"traceParent":                traceParent(msg.ApplicationProperties),
						"applicationProperties":      msg.ApplicationProperties,
						"enqueuedTimeUtc":            msg.EnqueuedTime,
						"expiresAtUtc":               msg.ExpiresAt,
						"deadLetterReason":           derefString(msg.DeadLetterReason),
						"deadLetterErrorDescription": derefString(msg.DeadLetterErrorDescription),
						"_source":                    queueType,
					}
					emitSearchMatch(p.RunID, matchRecord, elapsedSince(startedAt))
					emitOutput(p.RunID, fmt.Sprintf("🎯 MATCH # %d", matchesFound), false, elapsedSince(startedAt))

					emitOutput(p.RunID, "   MessageId: "+msg.MessageID, false, elapsedSince(startedAt))

					seqStr := "—"
					if msg.SequenceNumber != nil {
						seqStr = strconv.FormatInt(*msg.SequenceNumber, 10)
					}
					emitOutput(p.RunID, "   SequenceNumber: "+seqStr, false, elapsedSince(startedAt))

					enqueuedStr := "—"
					if msg.EnqueuedTime != nil {
						enqueuedStr = msg.EnqueuedTime.String()
					}
					emitOutput(p.RunID, "   Enqueued: "+enqueuedStr, false, elapsedSince(startedAt))

					if msg.DeadLetterReason != nil {
						emitOutput(p.RunID, "   DeadLetter Reason: "+*msg.DeadLetterReason, false, elapsedSince(startedAt))
					}
					if msg.DeadLetterErrorDescription != nil {
						emitOutput(p.RunID, "   DeadLetter Error: "+*msg.DeadLetterErrorDescription, false, elapsedSince(startedAt))
					}

					preview := body
					if len(preview) > 300 {
						preview = preview[:300] + "..."
					}
					emitOutput(p.RunID, "   Body Preview: "+preview, false, elapsedSince(startedAt))

					if grandMatches >= maxMatches {
						reachedLimit = true
						emitOutput(p.RunID,
							fmt.Sprintf("⏹ Reached max matches (%d). Stopping search.", maxMatches),
							false, elapsedSince(startedAt))
						break
					}
				}

				if msg.SequenceNumber != nil {
					next := *msg.SequenceNumber + 1
					fromSequenceNumber = &next
				} else {
					emitOutput(p.RunID,
						"⚠ Unable to advance sequence number. Stopping current search stream.",
						true, elapsedSince(startedAt))
					canAdvanceCursor = false
					break
				}
			}

			emitProgress(p.RunID,
				fmt.Sprintf("👀 Checked: %d | Matches: %d", totalChecked, matchesFound),
				elapsedSince(startedAt))

			if !canAdvanceCursor || reachedLimit {
				break
			}
		}

		emitOutput(p.RunID,
			fmt.Sprintf("✅ Finished %s. Checked: %d, Matches: %d in %.1fs",
				queueType, totalChecked, matchesFound, time.Since(stageStart).Seconds()),
			false, elapsedSince(startedAt))
		grandChecked += totalChecked
		return nil
	}

	if mode == "normal" || mode == "both" {
		receiver, err := client.NewReceiverForQueue(p.QueueName, nil)
		if err != nil {
			return nil, err
		}
		if err := runOne(receiver, "normal queue"); err != nil {
			return nil, err
		}
	}
	if !reachedLimit && (mode == "dlq" || mode == "both") {
		receiver, err := client.NewReceiverForQueue(p.QueueName,
			&azservicebus.ReceiverOptions{SubQueue: azservicebus.SubQueueDeadLetter})
		if err != nil {
			return nil, err
		}
		if err := runOne(receiver, "dead letter queue"); err != nil {
			return nil, err
		}
	}

	return map[string]any{
		"checked":      grandChecked,
		"matches":      grandMatches,
		"maxMatches":   maxMatches,
		"reachedLimit": reachedLimit,
	}, nil
}

// ─── 6. peekMessages ─────────────────────────────────────────────────────────

type peekMessagesParams struct {
	Argv         []string          `json:"argv"`
	Env          map[string]string `json:"env"`
	RunID        string            `json:"runId"`
	DownloadsDir string            `json:"downloadsDir"`
}

func handlePeekMessages(raw json.RawMessage) (any, error) {
	var p peekMessagesParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if len(p.Argv) == 0 {
		return nil, fmt.Errorf("peek arguments are required")
	}

	downloadsDir := p.DownloadsDir
	if downloadsDir == "" {
		downloadsDir, _ = os.Getwd()
	}

	// Parse argv — mirrors the JS worker's argument parsing logic exactly.
	var (
		entityType   = "queue"
		entityName   = ""
		subscription = ""
		countArg     = ""
		typeArg      = ""
		seqArg       = ""
	)

	first := p.Argv[0]
	if first == "queue" || first == "topic" {
		entityType = first
		if len(p.Argv) > 1 {
			entityName = p.Argv[1]
		}
		if entityType == "topic" {
			if len(p.Argv) > 2 {
				subscription = p.Argv[2]
			}
			if len(p.Argv) > 3 {
				countArg = p.Argv[3]
			}
			if len(p.Argv) > 4 {
				typeArg = p.Argv[4]
			}
			if len(p.Argv) > 5 {
				seqArg = p.Argv[5]
			}
		} else {
			if len(p.Argv) > 2 {
				countArg = p.Argv[2]
			}
			if len(p.Argv) > 3 {
				typeArg = p.Argv[3]
			}
			if len(p.Argv) > 4 {
				seqArg = p.Argv[4]
			}
		}
	} else {
		entityName = first
		if len(p.Argv) > 1 {
			countArg = p.Argv[1]
		}
		if len(p.Argv) > 2 {
			typeArg = p.Argv[2]
		}
		if len(p.Argv) > 3 {
			seqArg = p.Argv[3]
		}
	}

	labelStr := "Queue"
	if entityType == "topic" {
		labelStr = "Topic"
	}
	if err := validateEntityName(entityName, labelStr); err != nil {
		return nil, err
	}
	if entityType == "topic" {
		if err := validateEntityName(subscription, "Subscription"); err != nil {
			return nil, err
		}
	}

	count := parseIntOrDefault(countArg, 10)
	if count < 1 {
		return nil, fmt.Errorf("count must be a positive integer")
	}
	const maxCount = 10000
	if count > maxCount {
		count = maxCount
	}

	mode, err := validateMode(typeArg, "dlq")
	if err != nil {
		return nil, err
	}

	// Parse optional start sequence number.
	var startSeqNum *int64
	if trimmed := strings.TrimSpace(seqArg); trimmed != "" {
		n, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("start sequence number must be a positive integer")
		}
		startSeqNum = &n
	}

	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 60000)
	startedAt := time.Now()
	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer client.Close(context.Background())

	allMessages := []map[string]any{}
	const innerBatchSize = 250

	runOne := func(receiver *azservicebus.Receiver, sourceLabel string) error {
		defer receiver.Close(context.Background())

		seqNumHint := ""
		if startSeqNum != nil {
			seqNumHint = fmt.Sprintf(" (start sequence %d)", *startSeqNum)
		}
		emitOutput(p.RunID,
			fmt.Sprintf("👀 Peeking %d messages from %s%s...", count, sourceLabel, seqNumHint),
			false, elapsedSince(startedAt))

		fromSeqNum := startSeqNum
		canAdvanceCursor := true

		for len(allMessages) < count {
			remaining := count - len(allMessages)
			fetchCount := remaining
			if fetchCount > innerBatchSize {
				fetchCount = innerBatchSize
			}

			var opts *azservicebus.PeekMessagesOptions
			if fromSeqNum != nil {
				opts = &azservicebus.PeekMessagesOptions{FromSequenceNumber: fromSeqNum}
			}
			peekCtx, peekCancel := context.WithTimeout(context.Background(), time.Duration(maxWaitMs)*time.Millisecond)
			messages, err := receiver.PeekMessages(peekCtx, fetchCount, opts)
			peekCancel()
			if err != nil {
				return fmt.Errorf("peek error: %w", err)
			}
			if len(messages) == 0 {
				break
			}

			for _, msg := range messages {
				allMessages = append(allMessages, map[string]any{
					"messageId":                  msg.MessageID,
					"sequenceNumber":             msg.SequenceNumber,
					"body":                       bodyToJSON(msg.Body),
					"subject":                    derefString(msg.Subject),
					"contentType":                derefString(msg.ContentType),
					"correlationId":              derefString(msg.CorrelationID),
					"partitionKey":               derefString(msg.PartitionKey),
					"traceParent":                traceParent(msg.ApplicationProperties),
					"applicationProperties":      msg.ApplicationProperties,
					"enqueuedTimeUtc":            msg.EnqueuedTime,
					"expiresAtUtc":               msg.ExpiresAt,
					"deadLetterReason":           derefString(msg.DeadLetterReason),
					"deadLetterErrorDescription": derefString(msg.DeadLetterErrorDescription),
					"_source":                    sourceLabel,
				})

				if msg.SequenceNumber != nil {
					next := *msg.SequenceNumber + 1
					fromSeqNum = &next
				} else {
					emitOutput(p.RunID,
						"⚠ Unable to advance sequence number. Returning collected messages.",
						true, elapsedSince(startedAt))
					canAdvanceCursor = false
					break
				}
			}

			if count > innerBatchSize {
				emitProgress(p.RunID,
					fmt.Sprintf("📥 Retrieved: %d | messages...", len(allMessages)),
					elapsedSince(startedAt))
			}

			if !canAdvanceCursor {
				break
			}
		}

		emitOutput(p.RunID,
			fmt.Sprintf("✨ Found %d messages in %s.", len(allMessages), sourceLabel),
			false, elapsedSince(startedAt))
		return nil
	}

	if mode == "normal" || mode == "both" {
		if entityType == "queue" {
			receiver, err := client.NewReceiverForQueue(entityName, nil)
			if err != nil {
				return nil, err
			}
			if err := runOne(receiver, "Normal Queue: "+entityName); err != nil {
				return nil, err
			}
		} else {
			receiver, err := client.NewReceiverForSubscription(entityName, subscription, nil)
			if err != nil {
				return nil, err
			}
			if err := runOne(receiver, "Normal Subscription: "+entityName+"/"+subscription); err != nil {
				return nil, err
			}
		}
	}

	if mode == "dlq" || mode == "both" {
		dlqOpts := &azservicebus.ReceiverOptions{SubQueue: azservicebus.SubQueueDeadLetter}
		if entityType == "queue" {
			receiver, err := client.NewReceiverForQueue(entityName, dlqOpts)
			if err != nil {
				return nil, err
			}
			if err := runOne(receiver, "Dead Letter Queue: "+entityName); err != nil {
				return nil, err
			}
		} else {
			receiver, err := client.NewReceiverForSubscription(entityName, subscription, dlqOpts)
			if err != nil {
				return nil, err
			}
			if err := runOne(receiver, "Dead Letter Subscription: "+entityName+"/"+subscription); err != nil {
				return nil, err
			}
		}
	}

	if len(allMessages) == 0 {
		return map[string]any{
			"messages": []any{},
			"filename": "",
			"savedAt":  time.Now().UTC().Format(time.RFC3339),
		}, nil
	}

	// Persist to downloads dir — matches the JS filename format exactly.
	if err := os.MkdirAll(downloadsDir, 0o755); err != nil {
		return nil, fmt.Errorf("cannot create downloads dir: %w", err)
	}

	// JS: new Date().toISOString().replace(/[:.]/g, "-")
	ts := strings.ReplaceAll(strings.ReplaceAll(
		time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), ":", "-"), ".", "-")
	safeEntity := strings.ReplaceAll(entityName, "/", "-")
	var filename string
	if entityType == "queue" {
		filename = fmt.Sprintf("messages-%s-%s-%s.json", safeEntity, mode, ts)
	} else {
		safeSub := strings.ReplaceAll(subscription, "/", "-")
		filename = fmt.Sprintf("messages-%s-%s-%s-%s.json", safeEntity, safeSub, mode, ts)
	}

	fullPath := filepath.Join(downloadsDir, filename)
	data, err := json.MarshalIndent(allMessages, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("json marshal error: %w", err)
	}
	if err := os.WriteFile(fullPath, data, 0o644); err != nil {
		return nil, fmt.Errorf("write file error: %w", err)
	}

	savedAt := time.Now().UTC().Format(time.RFC3339)
	emitOutput(p.RunID,
		fmt.Sprintf("✅ Saved %d messages to %s", len(allMessages), filename),
		false, elapsedSince(startedAt))

	return map[string]any{
		"messages": allMessages,
		"filename": filename,
		"savedAt":  savedAt,
	}, nil
}

// ─── 7. sendMessage ──────────────────────────────────────────────────────────

type sendMessageParams struct {
	EntityName string            `json:"entityName"`
	Env        map[string]string `json:"env"`
	Message    map[string]any    `json:"message"`
}

func handleSendMessage(raw json.RawMessage) (any, error) {
	var p sendMessageParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.EntityName, "Entity"); err != nil {
		return nil, err
	}

	msg := p.Message
	if msg == nil {
		msg = map[string]any{}
	}

	// Body: if contentType is application/json, try to parse → re-encode for clean bytes.
	bodyStr, _ := msg["body"].(string)
	body := []byte(bodyStr)
	if ct, _ := msg["contentType"].(string); strings.Contains(ct, "application/json") {
		var jsonVal any
		if err := json.Unmarshal(body, &jsonVal); err == nil {
			if b, err := json.Marshal(jsonVal); err == nil {
				body = b
			}
		}
	}

	sbMsg := &azservicebus.Message{Body: body}

	if v, _ := msg["contentType"].(string); v != "" {
		sbMsg.ContentType = &v
	}
	if v, _ := msg["subject"].(string); v != "" {
		sbMsg.Subject = &v
	}
	if v, _ := msg["messageId"].(string); v != "" {
		sbMsg.MessageID = &v
	}
	if v, _ := msg["correlationId"].(string); v != "" {
		sbMsg.CorrelationID = &v
	}
	if v, _ := msg["sessionId"].(string); v != "" {
		sbMsg.SessionID = &v
	}
	if v, ok := msg["applicationProperties"].(map[string]any); ok {
		sbMsg.ApplicationProperties = v
	}
	if v, _ := msg["scheduledEnqueueTimeUtc"].(string); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err == nil {
			sbMsg.ScheduledEnqueueTime = &t
		}
	}

	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 60000)

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer client.Close(context.Background())

	sender, err := client.NewSender(p.EntityName, nil)
	if err != nil {
		return nil, fmt.Errorf("sender error: %w", err)
	}
	defer sender.Close(context.Background())

	sendCtx, sendCancel := context.WithTimeout(context.Background(), time.Duration(maxWaitMs)*time.Millisecond)
	defer sendCancel()
	if err := sender.SendMessage(sendCtx, sbMsg, nil); err != nil {
		return nil, fmt.Errorf("send error: %w", err)
	}
	return map[string]bool{"sent": true}, nil
}
