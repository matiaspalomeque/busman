package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

// ─── 6. peekMessages ─────────────────────────────────────────────────────────

type peekMessageReceiver interface {
	PeekMessages(context.Context, int, *azservicebus.PeekMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
}

func peekedMessageRecord(msg *azservicebus.ReceivedMessage, source, sourceLabel string) map[string]any {
	subQueue := "active"
	if source == "dlq" {
		subQueue = "deadLetter"
	}
	return map[string]any{
		"messageId":                  msg.MessageID,
		"sequenceNumber":             sequenceNumberValue(msg.SequenceNumber),
		"sessionId":                  derefString(msg.SessionID),
		"state":                      messageStateLabel(msg.State),
		"deliveryCount":              msg.DeliveryCount,
		"lockedUntilUtc":             derefTime(msg.LockedUntil),
		"sourceSubQueue":             subQueue,
		"body":                       string(msg.Body),
		"bodyIsJson":                 json.Valid(msg.Body),
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

// Leave space in a 32 MiB worker frame for its envelope, request ID and newline.
const peekPageBytes = (32 << 20) - 1024

type peekPage struct {
	messages         []json.RawMessage
	bytes            int
	truncatedSources []string
	recordLimit      int
}

func newPeekPage(hostRecordLimit int) peekPage {
	// Older hosts read at most 32 MiB per response.
	if hostRecordLimit <= 0 {
		hostRecordLimit = peekPageBytes
	}
	return peekPage{recordLimit: min(hostRecordLimit, 64<<20)}
}

// Read a bounded prefix. Active and dead-letter sources share the response byte
// budget but keep independent counts and cursors. Returning a value also lets a
// failed SDK peek retry through the management link from the original page.
func (page peekPage) readSource(
	requestCtx context.Context,
	receiver peekMessageReceiver,
	count int,
	startSeqNum *int64,
	maxWaitMs int,
	source, sourceLabel string,
	onProgress func(int),
) (peekPage, bool, error) {
	const innerBatchSize = 250
	start := len(page.messages)
	fromSeqNum := startSeqNum
	canAdvanceCursor := true

	for len(page.messages)-start < count {
		if page.bytes >= peekPageBytes {
			page.truncatedSources = append(page.truncatedSources, source)
			break
		}
		fetchCount := min(count-(len(page.messages)-start), innerBatchSize)
		var opts *azservicebus.PeekMessagesOptions
		if fromSeqNum != nil {
			opts = &azservicebus.PeekMessagesOptions{FromSequenceNumber: fromSeqNum}
		}
		peekCtx, peekCancel := context.WithTimeout(requestCtx, time.Duration(maxWaitMs)*time.Millisecond)
		messages, err := receiver.PeekMessages(peekCtx, fetchCount, opts)
		peekCancel()
		if err != nil {
			return page, canAdvanceCursor, fmt.Errorf("peek error: %w", err)
		}
		if len(messages) == 0 {
			break
		}

		for _, msg := range messages {
			record, err := json.Marshal(peekedMessageRecord(msg, source, sourceLabel))
			if err != nil {
				return page, canAdvanceCursor, fmt.Errorf("encode browsed message: %w", err)
			}
			if len(page.messages) != 0 && page.bytes+1+len(record) > peekPageBytes {
				page.truncatedSources = append(page.truncatedSources, source)
				return page, canAdvanceCursor, nil
			}
			// A single record can use the full byte capacity advertised by the host.
			if len(record) > page.recordLimit {
				return page, canAdvanceCursor, fmt.Errorf("message %v in %s needs %d encoded bytes, exceeding the browse limit of %d bytes",
					sequenceNumberValue(msg.SequenceNumber), sourceLabel, len(record), page.recordLimit)
			}
			page.messages = append(page.messages, record)
			page.bytes += len(record) + 1

			if msg.SequenceNumber != nil {
				next, ok := nextSequenceNumber(*msg.SequenceNumber)
				if ok {
					fromSeqNum = &next
					continue
				}
			}
			canAdvanceCursor = false
			break
		}

		if onProgress != nil {
			onProgress(len(page.messages) - start)
		}
		if !canAdvanceCursor {
			break
		}
	}
	return page, canAdvanceCursor, nil
}

type peekMessagesParams struct {
	MaxRecordBytes int               `json:"maxRecordBytes"`
	Argv           []string          `json:"argv"`
	Env            map[string]string `json:"env"`
	RunID          string            `json:"runId"`
}

func (page peekPage) result() map[string]any {
	if page.messages == nil {
		page.messages = []json.RawMessage{}
	}
	result := map[string]any{"messages": page.messages}
	if len(page.truncatedSources) > 0 {
		result["truncatedSources"] = page.truncatedSources
	}
	return result
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

	page := newPeekPage(p.MaxRecordBytes)

	runOne := func(receiver *azservicebus.Receiver, source, sourceLabel, activePath string) error {
		defer closeWithTimeout(receiver)

		seqNumHint := ""
		if startSeqNum != nil {
			seqNumHint = fmt.Sprintf(" (start sequence %d)", *startSeqNum)
		}
		emitOutput(p.RunID,
			fmt.Sprintf("👀 Peeking %d messages from %s%s...", count, sourceLabel, seqNumHint),
			false, elapsedSince(startedAt))

		onProgress := func(retrieved int) {
			if count > 250 {
				emitProgress(p.RunID,
					fmt.Sprintf("📥 Retrieved from %s: %d | messages...", sourceLabel, retrieved),
					elapsedSince(startedAt))
			}
		}
		nextPage, canAdvanceCursor, err := page.readSource(
			requestCtx, receiver, count, startSeqNum, maxWaitMs, source, sourceLabel, onProgress,
		)
		if activePath != "" && isSessionRequiredForBrowse(err) {
			peeker := &managementPeekReceiver{connectionString: cs, entityPath: activePath}
			defer peeker.close()
			nextPage, canAdvanceCursor, err = page.readSource(
				requestCtx, peeker, count, startSeqNum, maxWaitMs, source, sourceLabel, onProgress,
			)
		}
		if err != nil {
			return err
		}
		if !canAdvanceCursor {
			emitOutput(p.RunID,
				"⚠ Unable to advance sequence number. Returning collected messages.",
				true, elapsedSince(startedAt))
		}
		retrieved := len(nextPage.messages) - len(page.messages)
		page = nextPage

		emitOutput(p.RunID,
			fmt.Sprintf("✨ Found %d messages in %s.", retrieved, sourceLabel),
			false, elapsedSince(startedAt))
		return nil
	}

	if mode == "normal" || mode == "both" {
		if entityType == "queue" {
			receiver, err := client.NewReceiverForQueue(entityName, nil)
			if err != nil {
				return nil, err
			}
			if err := runOne(receiver, "normal", "Normal Queue: "+entityName, entityName); err != nil {
				return nil, err
			}
		} else {
			receiver, err := client.NewReceiverForSubscription(entityName, subscription, nil)
			if err != nil {
				return nil, err
			}
			path := entityName + "/Subscriptions/" + subscription
			if err := runOne(receiver, "normal", "Normal Subscription: "+entityName+"/"+subscription, path); err != nil {
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
			if err := runOne(receiver, "dlq", "Dead Letter Queue: "+entityName, ""); err != nil {
				return nil, err
			}
		} else {
			receiver, err := client.NewReceiverForSubscription(entityName, subscription, dlqOpts)
			if err != nil {
				return nil, err
			}
			if err := runOne(receiver, "dlq", "Dead Letter Subscription: "+entityName+"/"+subscription, ""); err != nil {
				return nil, err
			}
		}
	}

	if len(page.truncatedSources) > 0 {
		emitOutput(p.RunID, "Browse reached the page byte limit. Load More resumes the interrupted source first.", false, elapsedSince(startedAt))
	}
	return page.result(), nil
}
