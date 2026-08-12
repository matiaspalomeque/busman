package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

// ─── singleMessageAction ─────────────────────────────────────────────────────

type singleMessageActionParams struct {
	subscriptionSource
	Action         string            `json:"action"` // "delete" | "move" | "replay"
	SequenceNumber int64             `json:"sequenceNumber"`
	MessageID      string            `json:"messageId"`
	SessionID      *string           `json:"sessionId"`
	State          string            `json:"state"`
	Source         string            `json:"source"`
	SourceSubQueue string            `json:"sourceSubQueue"`
	IsDlq          bool              `json:"isDlq"`
	QueueName      string            `json:"queueName"`
	DestQueue      string            `json:"destQueue"`
	DestTopic      string            `json:"destTopic"`
	Env            map[string]string `json:"env"`
	RunID          string            `json:"runId"`
}

type singleMessageReceiver interface {
	ReceiveMessages(context.Context, int, *azservicebus.ReceiveMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
	ReceiveDeferredMessages(context.Context, []int64, *azservicebus.ReceiveDeferredMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
	CompleteMessage(context.Context, *azservicebus.ReceivedMessage, *azservicebus.CompleteMessageOptions) error
	AbandonMessage(context.Context, *azservicebus.ReceivedMessage, *azservicebus.AbandonMessageOptions) error
}

type singleMessageSender interface {
	SendMessage(context.Context, *azservicebus.Message, *azservicebus.SendMessageOptions) error
}

type messageLockRenewalReceiver interface {
	RenewMessageLock(context.Context, *azservicebus.ReceivedMessage, *azservicebus.RenewMessageLockOptions) error
}

type heldMessageLockRenewer struct {
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	receiver messageLockRenewalReceiver
	env      map[string]string
	maxWait  int
	interval time.Duration

	mu       sync.Mutex
	messages []*azservicebus.ReceivedMessage
	renewing *azservicebus.ReceivedMessage
	cond     *sync.Cond
	err      error
}

func heldMessageLockRenewInterval(now time.Time, messages []*azservicebus.ReceivedMessage) time.Duration {
	if len(messages) == 0 {
		return time.Second
	}
	interval := 20 * time.Second
	for _, msg := range messages {
		lockedUntil := time.Time{}
		if msg.LockedUntil != nil {
			lockedUntil = *msg.LockedUntil
		}
		candidate := sessionLockRenewInterval(now, lockedUntil)
		if candidate < interval {
			interval = candidate
		}
	}
	return interval
}

func startHeldMessageLockRenewer(
	parent context.Context,
	receiver messageLockRenewalReceiver,
	env map[string]string,
	maxWaitMs int,
	interval time.Duration,
) *heldMessageLockRenewer {
	ctx, cancel := context.WithCancel(parent)
	if interval <= 0 {
		interval = time.Second
	}
	renewer := &heldMessageLockRenewer{
		ctx:      ctx,
		cancel:   cancel,
		done:     make(chan struct{}),
		receiver: receiver,
		env:      env,
		maxWait:  maxWaitMs,
		interval: interval,
	}
	renewer.cond = sync.NewCond(&renewer.mu)

	go func() {
		defer close(renewer.done)
		ticker := time.NewTicker(renewer.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renewer.mu.Lock()
				messages := append([]*azservicebus.ReceivedMessage(nil), renewer.messages...)
				renewer.mu.Unlock()

				for _, msg := range messages {
					renewer.mu.Lock()
					if !renewer.containsLocked(msg) {
						renewer.mu.Unlock()
						continue
					}
					renewer.renewing = msg
					renewer.mu.Unlock()

					renewCtx, renewCancel := cancellableOperationContext(ctx, renewer.env, renewer.maxWait)
					err := renewer.receiver.RenewMessageLock(renewCtx, msg, nil)
					renewCancel()

					var renewalErr error
					renewer.mu.Lock()
					renewer.renewing = nil
					registered := renewer.containsLocked(msg)
					if err != nil && ctx.Err() == nil && registered {
						sequence := "unknown"
						if msg.SequenceNumber != nil {
							sequence = strconv.FormatInt(*msg.SequenceNumber, 10)
						}
						renewalErr = fmt.Errorf("renew message %s lock: %w", sequence, err)
						renewer.err = renewalErr
					}
					renewer.cond.Broadcast()
					renewer.mu.Unlock()

					if renewalErr != nil {
						// The target action uses this context, so a lock-renewal
						// failure prevents a slow send from proceeding to settlement.
						renewer.cancel()
						return
					}
					if err != nil && ctx.Err() != nil {
						return
					}
				}
			}
		}
	}()

	return renewer
}

func (r *heldMessageLockRenewer) containsLocked(message *azservicebus.ReceivedMessage) bool {
	for _, registered := range r.messages {
		if registered == message {
			return true
		}
	}
	return false
}

func (r *heldMessageLockRenewer) add(messages []*azservicebus.ReceivedMessage) {
	if len(messages) == 0 {
		return
	}
	r.mu.Lock()
	for _, message := range messages {
		if !r.containsLocked(message) {
			r.messages = append(r.messages, message)
		}
	}
	r.mu.Unlock()
}

func (r *heldMessageLockRenewer) unregister(message *azservicebus.ReceivedMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i, registered := range r.messages {
		if registered != message {
			continue
		}
		r.messages = append(r.messages[:i], r.messages[i+1:]...)
		break
	}
	for r.renewing == message {
		r.cond.Wait()
	}
}

func (r *heldMessageLockRenewer) actionContext() context.Context {
	return r.ctx
}

func (r *heldMessageLockRenewer) currentError() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.err
}

func (r *heldMessageLockRenewer) stop() error {
	r.cancel()
	<-r.done
	return r.currentError()
}

func abandonHeldMessages(
	receiver singleMessageReceiver,
	messages []*azservicebus.ReceivedMessage,
	env map[string]string,
	maxWaitMs int,
	concurrency int,
) error {
	if len(messages) == 0 {
		return nil
	}
	if concurrency < 1 {
		concurrency = 1
	}

	abandonOne := func(msg *azservicebus.ReceivedMessage) error {
		abandonCtx, abandonCancel := operationContext(env, maxWaitMs)
		err := receiver.AbandonMessage(abandonCtx, msg, nil)
		abandonCancel()
		if err == nil {
			return nil
		}
		sequence := "unknown"
		if msg.SequenceNumber != nil {
			sequence = strconv.FormatInt(*msg.SequenceNumber, 10)
		}
		return fmt.Errorf("abandon held non-target message %s: %w", sequence, err)
	}

	if concurrency == 1 {
		var abandonErrors []error
		for _, msg := range messages {
			if err := abandonOne(msg); err != nil {
				abandonErrors = append(abandonErrors, err)
			}
		}
		return errors.Join(abandonErrors...)
	}

	sem := make(chan struct{}, concurrency)
	errCh := make(chan error, len(messages))
	var wg sync.WaitGroup
	for _, msg := range messages {
		wg.Add(1)
		go func(message *azservicebus.ReceivedMessage) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := abandonOne(message); err != nil {
				errCh <- err
			}
		}(msg)
	}
	wg.Wait()
	close(errCh)

	var abandonErrors []error
	for err := range errCh {
		abandonErrors = append(abandonErrors, err)
	}
	return errors.Join(abandonErrors...)
}

type activeSingleMessageScanConfig struct {
	ScanBudget          int
	BatchSize           int
	MaxWaitMs           int
	IdleRetries         int
	CleanupConcurrency  int
	TargetKnown         bool
	LockRenewalInterval time.Duration
	ExternalLockError   func() error
	OnIdleRetry         func(int, int)
	OnProgress          func(int)
}

type activeSingleMessageScanResult struct {
	Found         bool
	TargetHandled bool
	Scanned       int
}

func scanActiveSingleMessage(
	requestCtx context.Context,
	receiver singleMessageReceiver,
	renewalReceiver messageLockRenewalReceiver,
	env map[string]string,
	targetSequence int64,
	config activeSingleMessageScanConfig,
	handleTarget func(context.Context, *azservicebus.ReceivedMessage) error,
) (result activeSingleMessageScanResult, err error) {
	if config.ScanBudget < 1 {
		return result, fmt.Errorf("single-message scan budget must be positive")
	}
	if config.BatchSize < 1 {
		return result, fmt.Errorf("single-message scan batch size must be positive")
	}
	if config.BatchSize > config.ScanBudget {
		config.BatchSize = config.ScanBudget
	}
	if config.IdleRetries < 0 {
		config.IdleRetries = 0
	}

	held := make([]*azservicebus.ReceivedMessage, 0, config.ScanBudget)
	var lockRenewer *heldMessageLockRenewer
	defer func() {
		var renewalErr error
		if lockRenewer != nil {
			renewalErr = lockRenewer.stop()
			if renewalErr != nil && err != nil && errors.Is(err, renewalErr) {
				renewalErr = nil
			}
		}
		cleanupErr := abandonHeldMessages(
			receiver,
			held,
			env,
			config.MaxWaitMs,
			config.CleanupConcurrency,
		)
		releaseErr := errors.Join(renewalErr, cleanupErr)
		if releaseErr == nil {
			return
		}
		releaseErr = fmt.Errorf("release %d held non-target messages: %w", len(held), releaseErr)
		if err != nil {
			err = errors.Join(err, releaseErr)
			return
		}
		if result.TargetHandled {
			err = fmt.Errorf("target action completed, but non-target cleanup was not fully successful: %w", releaseErr)
			return
		}
		err = releaseErr
	}()

	idleAttempts := 0
	for result.Scanned < config.ScanBudget {
		if config.ExternalLockError != nil {
			if lockErr := config.ExternalLockError(); lockErr != nil {
				return result, lockErr
			}
		}
		if lockRenewer != nil {
			if renewErr := lockRenewer.currentError(); renewErr != nil {
				return result, renewErr
			}
		}

		fetch := config.BatchSize
		if remaining := config.ScanBudget - result.Scanned; fetch > remaining {
			fetch = remaining
		}
		receiveCtx, receiveCancel := context.WithTimeout(requestCtx, time.Duration(config.MaxWaitMs)*time.Millisecond)
		messages, receiveErr := receiver.ReceiveMessages(receiveCtx, fetch, nil)
		receiveCancel()

		if len(messages) == 0 {
			if requestCtx.Err() != nil {
				return result, requestCtx.Err()
			}
			if receiveErr != nil && !errors.Is(receiveErr, context.DeadlineExceeded) && !errors.Is(receiveErr, context.Canceled) {
				return result, fmt.Errorf("receive error: %w", receiveErr)
			}
			if config.TargetKnown && idleAttempts < config.IdleRetries {
				idleAttempts++
				if config.OnIdleRetry != nil {
					config.OnIdleRetry(idleAttempts, config.IdleRetries)
				}
				continue
			}
			return result, nil
		}
		idleAttempts = 0

		targetIndex := -1
		heldStart := len(held)
		held = append(held, messages...)
		for i, message := range messages {
			if targetIndex == -1 && message.SequenceNumber != nil && *message.SequenceNumber == targetSequence {
				targetIndex = heldStart + i
			}
		}
		result.Scanned += len(messages)

		if renewalReceiver != nil && len(messages) > 0 {
			if lockRenewer == nil {
				interval := config.LockRenewalInterval
				if interval <= 0 {
					interval = heldMessageLockRenewInterval(time.Now(), messages)
				}
				lockRenewer = startHeldMessageLockRenewer(requestCtx, renewalReceiver, env, config.MaxWaitMs, interval)
			}
			lockRenewer.add(messages)
		}

		if requestCtx.Err() != nil {
			return result, requestCtx.Err()
		}
		if config.ExternalLockError != nil {
			if lockErr := config.ExternalLockError(); lockErr != nil {
				return result, lockErr
			}
		}
		if lockRenewer != nil {
			if renewErr := lockRenewer.currentError(); renewErr != nil {
				return result, renewErr
			}
		}

		if targetIndex >= 0 {
			target := held[targetIndex]
			held = append(held[:targetIndex], held[targetIndex+1:]...)
			result.Found = true
			targetCtx := requestCtx
			if lockRenewer != nil {
				targetCtx = lockRenewer.actionContext()
			}
			targetErr := handleTarget(targetCtx, target)
			var targetRenewalErr error
			if lockRenewer != nil {
				targetRenewalErr = lockRenewer.currentError()
				lockRenewer.unregister(target)
			}
			if targetErr != nil {
				if targetRenewalErr != nil && !errors.Is(targetErr, targetRenewalErr) {
					targetErr = errors.Join(targetErr, targetRenewalErr)
				}
				return result, targetErr
			}
			if targetRenewalErr != nil {
				return result, targetRenewalErr
			}
			result.TargetHandled = true
			return result, nil
		}
		if receiveErr != nil {
			return result, fmt.Errorf("receive error after receiving %d messages: %w", len(messages), receiveErr)
		}
		if config.OnProgress != nil {
			config.OnProgress(result.Scanned)
		}
	}

	return result, nil
}

func (p singleMessageActionParams) sourceSubQueue() azservicebus.SubQueue {
	switch p.SourceSubQueue {
	case "active":
		return 0
	case "deadLetter":
		if !p.IsDlq {
			return 0
		}
		return azservicebus.SubQueueDeadLetter
	case "transferDeadLetter":
		return azservicebus.SubQueueTransfer
	}
	if !p.IsDlq {
		return 0
	}
	if strings.Contains(strings.ToLower(p.Source), "transfer") {
		return azservicebus.SubQueueTransfer
	}
	return azservicebus.SubQueueDeadLetter
}

func entityNameWithSubQueue(name string, subQueue azservicebus.SubQueue) string {
	if strings.Contains(name, "/$DeadLetterQueue") || strings.Contains(name, "/$Transfer/$DeadLetterQueue") {
		return name
	}
	switch subQueue {
	case azservicebus.SubQueueDeadLetter:
		return name + "/$DeadLetterQueue"
	case azservicebus.SubQueueTransfer:
		return name + "/$Transfer/$DeadLetterQueue"
	default:
		return name
	}
}

func (p singleMessageActionParams) receiverOptions() *azservicebus.ReceiverOptions {
	subQueue := p.sourceSubQueue()
	if subQueue == 0 {
		return nil
	}
	return &azservicebus.ReceiverOptions{SubQueue: subQueue}
}

func (p singleMessageActionParams) destination() messageDestination {
	if p.Action == "replay" && p.isSubscription() {
		return messageDestination{Name: p.DestTopic, Kind: messageDestinationTopic}
	}
	if p.Action == "replay" {
		return messageDestination{Name: p.QueueName, Kind: messageDestinationQueue}
	}
	return messageDestination{Name: p.DestQueue, Kind: messageDestinationQueue}
}

func (p singleMessageActionParams) acceptSessionReceiver(ctx context.Context, client *azservicebus.Client, sessionID string) (*azservicebus.SessionReceiver, error) {
	queueName, topicName, subscriptionName := sessionReceiverEntityNames(p.QueueName, p.subscriptionSource, p.sourceSubQueue())
	if topicName != "" {
		return client.AcceptSessionForSubscription(ctx, topicName, subscriptionName, sessionID, nil)
	}
	return client.AcceptSessionForQueue(ctx, queueName, sessionID, nil)
}

func (p singleMessageActionParams) targetSessionID(peeked *azservicebus.ReceivedMessage) (string, bool) {
	if p.SessionID != nil {
		return *p.SessionID, true
	}
	if peeked != nil && peeked.SessionID != nil {
		return *peeked.SessionID, true
	}
	return "", false
}

func validateSingleMessageTarget(p singleMessageActionParams, msg *azservicebus.ReceivedMessage, phase string) error {
	if msg.SequenceNumber == nil || *msg.SequenceNumber != p.SequenceNumber {
		return fmt.Errorf("received unexpected message while %s sequence number %d", phase, p.SequenceNumber)
	}
	if p.MessageID != "" && msg.MessageID != p.MessageID {
		return fmt.Errorf("sequence number %d now belongs to messageId %q, expected %q; refresh the peeked messages before retrying", p.SequenceNumber, msg.MessageID, p.MessageID)
	}
	if p.SessionID != nil {
		if msg.SessionID == nil || *msg.SessionID != *p.SessionID {
			got := "<nil>"
			if msg.SessionID != nil {
				got = *msg.SessionID
			}
			return fmt.Errorf("sequence number %d now belongs to sessionId %q, expected %q; refresh the peeked messages before retrying", p.SequenceNumber, got, *p.SessionID)
		}
	}
	return nil
}

func performSingleMessageTargetAction(
	requestCtx context.Context,
	p singleMessageActionParams,
	receiver singleMessageReceiver,
	sender singleMessageSender,
	target *azservicebus.ReceivedMessage,
	regenerateMessageID bool,
	maxWaitMs int,
	onAmbiguousSettlement func(error),
) error {
	abandonTarget := func() error {
		abandonCtx, abandonCancel := operationContext(p.Env, maxWaitMs)
		err := receiver.AbandonMessage(abandonCtx, target, nil)
		abandonCancel()
		if err != nil {
			return fmt.Errorf("abandon target message after action failure: %w", err)
		}
		return nil
	}
	failAndReleaseTarget := func(actionErr error) error {
		if abandonErr := abandonTarget(); abandonErr != nil {
			return errors.Join(actionErr, abandonErr)
		}
		return actionErr
	}
	completeTarget := func() error {
		completeCtx, completeCancel := cancellableOperationContext(requestCtx, p.Env, maxWaitMs)
		err := receiver.CompleteMessage(completeCtx, target, nil)
		completeCancel()
		if err != nil {
			return fmt.Errorf("complete message error: %w", err)
		}
		return nil
	}

	if err := validateSingleMessageTarget(p, target, "receiving"); err != nil {
		return failAndReleaseTarget(err)
	}
	switch p.Action {
	case "delete":
		return completeTarget()
	case "move", "replay":
		if sender == nil {
			return failAndReleaseTarget(fmt.Errorf("%s requires a destination sender", p.Action))
		}
		newMsg := outboundMessageFromReceived(target, regenerateMessageID)
		sendCtx, sendCancel := cancellableOperationContext(requestCtx, p.Env, maxWaitMs)
		err := sender.SendMessage(sendCtx, newMsg, nil)
		sendCancel()
		if err != nil {
			return failAndReleaseTarget(fmt.Errorf("send message error: %w", err))
		}
		if err := completeTarget(); err != nil {
			failure := fmt.Errorf("destination accepted the message but source settlement failed; duplicate delivery is possible: %w", err)
			if onAmbiguousSettlement != nil {
				onAmbiguousSettlement(failure)
			}
			return failure
		}
		return nil
	default:
		return failAndReleaseTarget(fmt.Errorf("unknown action %q", p.Action))
	}
}

func singleMessageNotReceivableError(p singleMessageActionParams, entityLabel string, peeked *azservicebus.ReceivedMessage, scanned int) error {
	details := []string{}
	if peeked != nil {
		details = append(details, "state="+messageStateLabel(peeked.State))
		if peeked.MessageID != "" {
			details = append(details, "messageId="+peeked.MessageID)
		}
		if peeked.SessionID != nil {
			details = append(details, "sessionId="+*peeked.SessionID)
		}
		if peeked.LockedUntil != nil {
			details = append(details, "lockedUntilUtc="+peeked.LockedUntil.Format(time.RFC3339))
		}
	}
	if len(details) == 0 {
		return fmt.Errorf("message with sequence number %d not found in %s after scanning %d messages", p.SequenceNumber, entityLabel, scanned)
	}
	return fmt.Errorf("message with sequence number %d exists in %s but is not currently receivable after scanning %d messages (%s). It may be locked by another receiver, deferred, scheduled, or behind the scan budget; refresh and retry after the lock expires", p.SequenceNumber, entityLabel, scanned, strings.Join(details, ", "))
}

func handleSingleMessageAction(requestCtx context.Context, raw json.RawMessage) (any, error) {
	var p singleMessageActionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}

	switch p.Action {
	case "delete", "move", "replay":
	default:
		return nil, fmt.Errorf("unknown action %q: must be delete, move, or replay", p.Action)
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

	if p.Action == "move" {
		if err := validateEntityName(p.DestQueue, "Destination queue"); err != nil {
			return nil, fmt.Errorf("move requires a valid destination queue: %w", err)
		}
	}
	if p.Action == "replay" && p.isSubscription() {
		if err := validateEntityName(p.DestTopic, "Destination topic"); err != nil {
			return nil, fmt.Errorf("subscription replay requires a valid destination topic: %w", err)
		}
	}

	startedAt := time.Now()
	// The Go SDK renews message locks individually. Keep the held-lock set within
	// one supported receive ceiling so arbitrary configuration cannot lock an
	// unbounded portion of the entity while resolving one target.
	scanBudget := boundedIntFromEnv(p.Env, "SINGLE_MSG_SCAN_BUDGET", maxReceiveBatchSize, maxReceiveBatchSize)
	if scanBudget < 50 {
		scanBudget = 50
	}
	batchSize := boundedIntFromEnv(p.Env, "RECEIVE_MESSAGES_COUNT", 50, maxReceiveBatchSize)
	if batchSize > scanBudget {
		batchSize = scanBudget
	}
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 5000)
	completeConcurrency := parseIntOrDefault(p.Env["COMPLETE_CONCURRENCY"], 8)
	if completeConcurrency < 1 {
		completeConcurrency = 1
	}
	if completeConcurrency > 32 {
		completeConcurrency = 32
	}

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer closeWithTimeout(client)

	receiverOpts := p.receiverOptions()
	var receiver *azservicebus.Receiver
	if p.isSubscription() {
		receiver, err = client.NewReceiverForSubscription(p.TopicName, p.SubscriptionName, receiverOpts)
	} else {
		receiver, err = client.NewReceiverForQueue(p.QueueName, receiverOpts)
	}
	if err != nil {
		return nil, fmt.Errorf("receiver error: %w", err)
	}
	defer closeWithTimeout(receiver)

	var sender *azservicebus.Sender
	regenerateMessageID := false
	if p.Action == "move" || p.Action == "replay" {
		destination := p.destination()
		destEntity := destination.Name
		sender, err = client.NewSender(destEntity, nil)
		if err != nil {
			return nil, fmt.Errorf("sender error: %w", err)
		}
		defer closeWithTimeout(sender)

		dupCtx, dupCancel := context.WithTimeout(requestCtx, time.Duration(maxWaitMs)*time.Millisecond)
		sendPolicy, dupErr := inspectDestinationPolicy(dupCtx, cs, destination)
		dupCancel()
		if dupErr != nil {
			return nil, fmt.Errorf(
				"cannot safely %s message to %s %q because its duplicate-detection configuration could not be read; the source message was not received or completed: %w",
				p.Action,
				destination.Kind,
				destEntity,
				dupErr,
			)
		} else if sendPolicy.RequiresDuplicateDetection {
			regenerateMessageID = true
			emitOutput(p.RunID,
				fmt.Sprintf("ℹ Destination %q uses duplicate detection; %s will generate a new MessageId and store the original in BusmanOriginalMessageId.", destEntity, p.Action),
				false, elapsedSince(startedAt))
		}
	}

	entityLabel := p.label(p.QueueName)
	if p.IsDlq {
		entityLabel += " (DLQ)"
	}
	emitOutput(p.RunID,
		fmt.Sprintf("🔍 Resolving message with sequence number %d in %s...", p.SequenceNumber, entityLabel),
		false, elapsedSince(startedAt))

	peekCtx, peekCancel := context.WithTimeout(requestCtx, time.Duration(maxWaitMs)*time.Millisecond)
	peekedMessages, peekErr := receiver.PeekMessages(peekCtx, 1, &azservicebus.PeekMessagesOptions{FromSequenceNumber: &p.SequenceNumber})
	peekCancel()
	var peekedTarget *azservicebus.ReceivedMessage
	if peekErr != nil {
		emitOutput(p.RunID,
			fmt.Sprintf("⚠ Could not peek sequence number %d before receiving: %v", p.SequenceNumber, peekErr),
			true, elapsedSince(startedAt))
	} else if len(peekedMessages) > 0 && peekedMessages[0].SequenceNumber != nil && *peekedMessages[0].SequenceNumber == p.SequenceNumber {
		peekedTarget = peekedMessages[0]
		if err := validateSingleMessageTarget(p, peekedTarget, "peeking"); err != nil {
			return nil, err
		}
		emitOutput(p.RunID,
			fmt.Sprintf("👀 Found target by peek: state=%s, deliveryCount=%d", messageStateLabel(peekedTarget.State), peekedTarget.DeliveryCount),
			false, elapsedSince(startedAt))
	} else if len(peekedMessages) > 0 && peekedMessages[0].SequenceNumber != nil {
		return nil, fmt.Errorf("message with sequence number %d was not found in %s; next available sequence is %d", p.SequenceNumber, entityLabel, *peekedMessages[0].SequenceNumber)
	} else {
		return nil, fmt.Errorf("message with sequence number %d was not found in %s", p.SequenceNumber, entityLabel)
	}

	var actionSender singleMessageSender
	if sender != nil {
		actionSender = sender
	}
	handleTarget := func(actionCtx context.Context, actionReceiver singleMessageReceiver, target *azservicebus.ReceivedMessage) error {
		return performSingleMessageTargetAction(
			actionCtx,
			p,
			actionReceiver,
			actionSender,
			target,
			regenerateMessageID,
			maxWaitMs,
			func(failure error) {
				emitOutput(p.RunID, "⚠ "+failure.Error(), true, elapsedSince(startedAt))
			},
		)
	}

	receiveDeferredTarget := func(actionReceiver singleMessageReceiver) error {
		emitOutput(p.RunID,
			fmt.Sprintf("↩ Receiving deferred message %d directly by sequence number...", p.SequenceNumber),
			false, elapsedSince(startedAt))
		deferCtx, deferCancel := cancellableOperationContext(requestCtx, p.Env, maxWaitMs)
		deferred, deferErr := actionReceiver.ReceiveDeferredMessages(deferCtx, []int64{p.SequenceNumber}, nil)
		deferCancel()
		if deferErr != nil {
			return fmt.Errorf("receive deferred message error: %w", deferErr)
		}
		if len(deferred) == 0 {
			return singleMessageNotReceivableError(p, entityLabel, peekedTarget, 0)
		}
		if err := handleTarget(requestCtx, actionReceiver, deferred[0]); err != nil {
			return err
		}
		emitOutput(p.RunID,
			fmt.Sprintf("✅ %s completed for deferred message %d in %.2fs", p.Action, p.SequenceNumber, time.Since(startedAt).Seconds()),
			false, elapsedSince(startedAt))
		return nil
	}

	if peekedTarget != nil {
		switch peekedTarget.State {
		case azservicebus.MessageStateDeferred:
			if sessionID, ok := p.targetSessionID(peekedTarget); ok {
				emitOutput(p.RunID,
					fmt.Sprintf("🔐 Accepting session %q for deferred message %d...", sessionID, p.SequenceNumber),
					false, elapsedSince(startedAt))
				sessionCtx, sessionCancel := cancellableOperationContext(requestCtx, p.Env, maxWaitMs)
				sessionReceiver, sessionErr := p.acceptSessionReceiver(sessionCtx, client, sessionID)
				sessionCancel()
				if sessionErr != nil {
					return nil, fmt.Errorf("accept session %q error: %w", sessionID, sessionErr)
				}
				renewer := startSessionLockRenewer(
					requestCtx,
					sessionReceiver,
					maxWaitMs,
					sessionLockRenewInterval(time.Now(), sessionReceiver.LockedUntil()),
				)
				receiveErr := receiveDeferredTarget(sessionReceiver)
				renewErr := renewer.stop()
				closeWithTimeout(sessionReceiver)
				if receiveErr != nil {
					return nil, receiveErr
				}
				if renewErr != nil {
					return nil, renewErr
				}
				return map[string]string{"sequenceNumber": strconv.FormatInt(p.SequenceNumber, 10)}, nil
			}
			if err := receiveDeferredTarget(receiver); err != nil {
				return nil, err
			}
			return map[string]string{"sequenceNumber": strconv.FormatInt(p.SequenceNumber, 10)}, nil
		case azservicebus.MessageStateScheduled:
			return nil, fmt.Errorf("message with sequence number %d is scheduled in %s and cannot be settled until it becomes active", p.SequenceNumber, entityLabel)
		}
	}

	actionReceiver := singleMessageReceiver(receiver)
	var sessionRenewer *sessionLockRenewer
	var renewalReceiver messageLockRenewalReceiver
	cleanupConcurrency := completeConcurrency
	if sessionID, ok := p.targetSessionID(peekedTarget); ok {
		emitOutput(p.RunID,
			fmt.Sprintf("🔐 Accepting session %q for active message %d...", sessionID, p.SequenceNumber),
			false, elapsedSince(startedAt))
		sessionCtx, sessionCancel := cancellableOperationContext(requestCtx, p.Env, maxWaitMs)
		sessionReceiver, sessionErr := p.acceptSessionReceiver(sessionCtx, client, sessionID)
		sessionCancel()
		if sessionErr != nil {
			return nil, fmt.Errorf("accept session %q error: %w", sessionID, sessionErr)
		}
		defer closeWithTimeout(sessionReceiver)
		actionReceiver = sessionReceiver
		sessionRenewer = startSessionLockRenewer(
			requestCtx,
			sessionReceiver,
			maxWaitMs,
			sessionLockRenewInterval(time.Now(), sessionReceiver.LockedUntil()),
		)
		cleanupConcurrency = 1
	} else {
		var ok bool
		renewalReceiver, ok = actionReceiver.(messageLockRenewalReceiver)
		if !ok {
			return nil, fmt.Errorf("active single-message scanning requires message-lock renewal support")
		}
	}

	idleRetries := parseIntOrDefault(p.Env["SINGLE_MSG_IDLE_RETRIES"], 3)
	scanConfig := activeSingleMessageScanConfig{
		ScanBudget:         scanBudget,
		BatchSize:          batchSize,
		MaxWaitMs:          maxWaitMs,
		IdleRetries:        idleRetries,
		CleanupConcurrency: cleanupConcurrency,
		TargetKnown:        peekedTarget != nil,
		OnIdleRetry: func(attempt, total int) {
			emitProgress(p.RunID,
				fmt.Sprintf("Target exists but was not receivable yet; retry %d/%d...", attempt, total),
				elapsedSince(startedAt))
		},
		OnProgress: func(scanned int) {
			if scanned > 0 && scanned%100 == 0 {
				emitProgress(p.RunID,
					fmt.Sprintf("Scanned %d messages while retaining non-target locks...", scanned),
					elapsedSince(startedAt))
			}
		},
	}
	if sessionRenewer != nil {
		scanConfig.ExternalLockError = sessionRenewer.currentError
	}

	scanResult, scanErr := scanActiveSingleMessage(
		requestCtx,
		actionReceiver,
		renewalReceiver,
		p.Env,
		p.SequenceNumber,
		scanConfig,
		func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
			return handleTarget(actionCtx, actionReceiver, target)
		},
	)
	if sessionRenewer != nil {
		renewErr := sessionRenewer.stop()
		if renewErr != nil && (scanErr == nil || !errors.Is(scanErr, renewErr)) {
			scanErr = errors.Join(scanErr, renewErr)
		}
	}
	if scanErr != nil {
		return nil, scanErr
	}
	if !scanResult.Found {
		return nil, singleMessageNotReceivableError(p, entityLabel, peekedTarget, scanResult.Scanned)
	}

	emitOutput(p.RunID,
		fmt.Sprintf("✅ %s completed for message %d in %.2fs", p.Action, p.SequenceNumber, time.Since(startedAt).Seconds()),
		false, elapsedSince(startedAt))
	return map[string]string{"sequenceNumber": strconv.FormatInt(p.SequenceNumber, 10)}, nil
}
