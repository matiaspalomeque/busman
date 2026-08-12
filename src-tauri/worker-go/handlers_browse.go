package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

// ─── 5. searchMessages ───────────────────────────────────────────────────────

type searchMessagesParams struct {
	QueueName    string            `json:"queueName"`
	SearchString string            `json:"searchString"`
	Mode         string            `json:"mode"`
	MaxMatches   any               `json:"maxMatches"`
	Env          map[string]string `json:"env"`
	RunID        string            `json:"runId"`
}

func handleSearchMessages(requestCtx context.Context, raw json.RawMessage) (any, error) {
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
	if maxMatches > maxSearchMatches {
		maxMatches = maxSearchMatches
	}

	batchSize := boundedIntFromEnv(p.Env, "BATCH_SIZE", 50, maxPeekBatchSize)
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 60000)
	caseSensitive := p.Env["CASE_SENSITIVE"] == "true"
	startedAt := time.Now()

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer closeWithTimeout(client)

	grandChecked := 0
	grandMatches := 0
	reachedLimit := false

	searchLower := strings.ToLower(searchStr)

	runOne := func(receiver *azservicebus.Receiver, queueType string) error {
		defer closeWithTimeout(receiver)
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
			peekCtx, peekCancel := context.WithTimeout(requestCtx, time.Duration(maxWaitMs)*time.Millisecond)
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
						"sequenceNumber":             sequenceNumberValue(msg.SequenceNumber),
						"sessionId":                  derefString(msg.SessionID),
						"state":                      messageStateLabel(msg.State),
						"deliveryCount":              msg.DeliveryCount,
						"lockedUntilUtc":             derefTime(msg.LockedUntil),
						"sourceSubQueue":             sourceSubQueueLabel(queueType),
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
					next, ok := nextSequenceNumber(*msg.SequenceNumber)
					if !ok {
						canAdvanceCursor = false
						break
					}
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

type peekMessageReceiver interface {
	PeekMessages(context.Context, int, *azservicebus.PeekMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
}

func peekedMessageRecord(msg *azservicebus.ReceivedMessage, sourceLabel string) map[string]any {
	return map[string]any{
		"messageId":                  msg.MessageID,
		"sequenceNumber":             sequenceNumberValue(msg.SequenceNumber),
		"sessionId":                  derefString(msg.SessionID),
		"state":                      messageStateLabel(msg.State),
		"deliveryCount":              msg.DeliveryCount,
		"lockedUntilUtc":             derefTime(msg.LockedUntil),
		"sourceSubQueue":             sourceSubQueueLabel(sourceLabel),
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
	}
}

// peekMessagesForSource retrieves one source-local page. In "both" mode the
// caller invokes it once for the active entity and once for its dead-letter
// subqueue, so count and cursor progression remain independent.
func peekMessagesForSource(
	requestCtx context.Context,
	receiver peekMessageReceiver,
	count int,
	startSeqNum *int64,
	maxWaitMs int,
	sourceLabel string,
	onProgress func(int),
) ([]map[string]any, bool, error) {
	const innerBatchSize = 250

	messagesForSource := make([]map[string]any, 0, count)
	fromSeqNum := startSeqNum
	canAdvanceCursor := true

	for len(messagesForSource) < count {
		fetchCount := count - len(messagesForSource)
		if fetchCount > innerBatchSize {
			fetchCount = innerBatchSize
		}

		var opts *azservicebus.PeekMessagesOptions
		if fromSeqNum != nil {
			opts = &azservicebus.PeekMessagesOptions{FromSequenceNumber: fromSeqNum}
		}
		peekCtx, peekCancel := context.WithTimeout(requestCtx, time.Duration(maxWaitMs)*time.Millisecond)
		messages, err := receiver.PeekMessages(peekCtx, fetchCount, opts)
		peekCancel()
		if err != nil {
			return nil, canAdvanceCursor, fmt.Errorf("peek error: %w", err)
		}
		if len(messages) == 0 {
			break
		}

		for _, msg := range messages {
			messagesForSource = append(messagesForSource, peekedMessageRecord(msg, sourceLabel))

			if msg.SequenceNumber != nil {
				next, ok := nextSequenceNumber(*msg.SequenceNumber)
				if !ok {
					canAdvanceCursor = false
					break
				}
				fromSeqNum = &next
			} else {
				canAdvanceCursor = false
				break
			}
		}

		if onProgress != nil {
			onProgress(len(messagesForSource))
		}
		if !canAdvanceCursor {
			break
		}
	}

	return messagesForSource, canAdvanceCursor, nil
}

type peekMessagesParams struct {
	Argv  []string          `json:"argv"`
	Env   map[string]string `json:"env"`
	RunID string            `json:"runId"`
}

func peekMessagesResult(messages []map[string]any) map[string]any {
	if messages == nil {
		messages = []map[string]any{}
	}
	return map[string]any{"messages": messages}
}

func parsePeekCount(countArg string) (int, error) {
	count := 10
	if countArg != "" {
		parsed, err := strconv.Atoi(countArg)
		if err != nil || parsed < 1 {
			return 0, fmt.Errorf("count must be a positive integer")
		}
		count = parsed
	}
	if count > maxPeekPageMessages {
		return 0, fmt.Errorf("count must not exceed %d messages per source", maxPeekPageMessages)
	}
	return count, nil
}

func handlePeekMessages(requestCtx context.Context, raw json.RawMessage) (any, error) {
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

	count, err := parsePeekCount(countArg)
	if err != nil {
		return nil, err
	}

	mode, err := validateMode(typeArg, "dlq")
	if err != nil {
		return nil, err
	}

	// Parse optional start sequence number.
	var startSeqNum *int64
	if seqArg != "" {
		n, err := parseSequenceNumber(seqArg)
		if err != nil {
			return nil, fmt.Errorf("invalid start sequence number: %w", err)
		}
		startSeqNum = &n
	}

	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 60000)
	startedAt := time.Now()
	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer closeWithTimeout(client)

	allMessages := []map[string]any{}

	runOne := func(receiver *azservicebus.Receiver, sourceLabel string) error {
		defer closeWithTimeout(receiver)

		seqNumHint := ""
		if startSeqNum != nil {
			seqNumHint = fmt.Sprintf(" (start sequence %d)", *startSeqNum)
		}
		emitOutput(p.RunID,
			fmt.Sprintf("👀 Peeking %d messages from %s%s...", count, sourceLabel, seqNumHint),
			false, elapsedSince(startedAt))

		messages, canAdvanceCursor, err := peekMessagesForSource(
			requestCtx,
			receiver,
			count,
			startSeqNum,
			maxWaitMs,
			sourceLabel,
			func(retrieved int) {
				if count > 250 {
					emitProgress(p.RunID,
						fmt.Sprintf("📥 Retrieved from %s: %d | messages...", sourceLabel, retrieved),
						elapsedSince(startedAt))
				}
			},
		)
		if err != nil {
			return err
		}
		if !canAdvanceCursor {
			emitOutput(p.RunID,
				"⚠ Unable to advance sequence number. Returning collected messages.",
				true, elapsedSince(startedAt))
		}
		allMessages = append(allMessages, messages...)

		emitOutput(p.RunID,
			fmt.Sprintf("✨ Found %d messages in %s.", len(messages), sourceLabel),
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

	return peekMessagesResult(allMessages), nil
}
