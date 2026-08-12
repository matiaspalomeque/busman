package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

// ─── Admin client cache ─────────────────────────────────────────────────────
// Reuses admin.Client instances per connection string to avoid repeated
// HTTP client + auth token setup on every request.

var adminClientCache sync.Map // map[string]*admin.Client

func getAdminClient(connectionString string) (*admin.Client, error) {
	if v, ok := adminClientCache.Load(connectionString); ok {
		return v.(*admin.Client), nil
	}
	client, err := admin.NewClientFromConnectionString(connectionString, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
	}
	actual, _ := adminClientCache.LoadOrStore(connectionString, client)
	return actual.(*admin.Client), nil
}

// ─── Shared validation / parsing helpers ─────────────────────────────────────

const entityNameMaxLen = 260
const maxReceiveBatchSize = 500
const maxPeekBatchSize = 500
const maxPeekPageMessages = 5000
const maxSearchMatches = 10000

var entityNameRe = regexp.MustCompile(`^[a-zA-Z0-9._\-/]+$`)
var sequenceNumberRe = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

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

func parseSequenceNumber(s string) (int64, error) {
	if !sequenceNumberRe.MatchString(s) {
		return 0, fmt.Errorf("sequence number must be a canonical non-negative 64-bit integer")
	}
	value, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("sequence number must be a canonical non-negative 64-bit integer")
	}
	return value, nil
}

func sequenceNumberValue(sequenceNumber *int64) any {
	if sequenceNumber == nil {
		return nil
	}
	return strconv.FormatInt(*sequenceNumber, 10)
}

func nextSequenceNumber(sequenceNumber int64) (int64, bool) {
	if sequenceNumber == math.MaxInt64 {
		return 0, false
	}
	return sequenceNumber + 1, true
}

func boundedIntFromEnv(env map[string]string, key string, def int, max int) int {
	v := parseIntOrDefault(env[key], def)
	if v < 1 {
		return 1
	}
	if v > max {
		return max
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

func timeoutMsFromEnv(env map[string]string, key string, def int) int {
	ms := parseIntOrDefault(env[key], def)
	if ms < 1000 {
		return 1000
	}
	return ms
}

func operationContext(env map[string]string, defMs int) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), time.Duration(timeoutMsFromEnv(env, "OPERATION_TIMEOUT_IN_MS", defMs))*time.Millisecond)
}

func cancellableOperationContext(parent context.Context, env map[string]string, defMs int) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, time.Duration(timeoutMsFromEnv(env, "OPERATION_TIMEOUT_IN_MS", defMs))*time.Millisecond)
}

func closeWithTimeout(resource interface{ Close(context.Context) error }) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = resource.Close(ctx)
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

func derefTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Format(time.RFC3339)
}

func messageStateLabel(state azservicebus.MessageState) string {
	switch state {
	case azservicebus.MessageStateActive:
		return "active"
	case azservicebus.MessageStateDeferred:
		return "deferred"
	case azservicebus.MessageStateScheduled:
		return "scheduled"
	default:
		return strconv.FormatInt(int64(state), 10)
	}
}

func sourceSubQueueLabel(sourceLabel string) string {
	lower := strings.ToLower(sourceLabel)
	if strings.Contains(lower, "transfer") {
		return "transferDeadLetter"
	}
	if strings.Contains(lower, "dead letter") {
		return "deadLetter"
	}
	return "active"
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

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := operationContext(p.Env, 60000)
	defer cancel()
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

// ─── 2b. getQueueCount / getSubscriptionCount ────────────────────────────────

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

type queueCountParams struct {
	Env       map[string]string `json:"env"`
	QueueName string            `json:"queueName"`
}

func handleGetQueueCount(raw json.RawMessage) (any, error) {
	var p queueCountParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.QueueName, "Queue"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var active, dlq int64
	resp, err := adminClient.GetQueueRuntimeProperties(ctx, p.QueueName, nil)
	if err != nil {
		return nil, fmt.Errorf("get queue runtime properties: %w", err)
	}
	if resp != nil {
		active = int64(resp.ActiveMessageCount)
		dlq = int64(resp.DeadLetterMessageCount)
	}
	return queueCountResult{Name: p.QueueName, Active: active, DLQ: dlq}, nil
}

type subscriptionCountParams struct {
	Env              map[string]string `json:"env"`
	TopicName        string            `json:"topicName"`
	SubscriptionName string            `json:"subscriptionName"`
}

func handleGetSubscriptionCount(raw json.RawMessage) (any, error) {
	var p subscriptionCountParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.TopicName, "Topic"); err != nil {
		return nil, err
	}
	if err := validateEntityName(p.SubscriptionName, "Subscription"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var active, dlq int64
	resp, err := adminClient.GetSubscriptionRuntimeProperties(ctx, p.TopicName, p.SubscriptionName, nil)
	if err != nil {
		return nil, fmt.Errorf("get subscription runtime properties: %w", err)
	}
	if resp != nil {
		active = int64(resp.ActiveMessageCount)
		dlq = int64(resp.DeadLetterMessageCount)
	}
	return subscriptionCountResult{Topic: p.TopicName, Subscription: p.SubscriptionName, Active: active, DLQ: dlq}, nil
}

// ─── 2c. getTopicSubscriptionCounts (batch) ─────────────────────────────────

type topicSubscriptionCountsParams struct {
	Env       map[string]string `json:"env"`
	TopicName string            `json:"topicName"`
}

type topicSubscriptionCountsResult struct {
	Topic         string                    `json:"topic"`
	Subscriptions []subscriptionCountResult `json:"subscriptions"`
}

func handleGetTopicSubscriptionCounts(raw json.RawMessage) (any, error) {
	var p topicSubscriptionCountsParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.TopicName, "Topic"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	var subs []subscriptionCountResult
	pager := adminClient.NewListSubscriptionsRuntimePropertiesPager(p.TopicName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list subscription runtime properties: %w", err)
		}
		for _, s := range page.SubscriptionRuntimeProperties {
			subs = append(subs, subscriptionCountResult{
				Topic:        p.TopicName,
				Subscription: s.SubscriptionName,
				Active:       int64(s.ActiveMessageCount),
				DLQ:          int64(s.DeadLetterMessageCount),
			})
		}
	}

	if subs == nil {
		subs = []subscriptionCountResult{}
	}
	return topicSubscriptionCountsResult{Topic: p.TopicName, Subscriptions: subs}, nil
}

type entityCountsParams struct {
	Env        map[string]string `json:"env"`
	QueueNames []string          `json:"queueNames"`
	TopicNames []string          `json:"topicNames"`
}

type entityCountError struct {
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	Error string `json:"error"`
}

type entityCountsResult struct {
	Queues        []queueCountResult        `json:"queues"`
	Subscriptions []subscriptionCountResult `json:"subscriptions"`
	Errors        []entityCountError        `json:"errors"`
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
	for _, name := range p.QueueNames {
		if err := validateEntityName(name, "Queue"); err != nil {
			return nil, err
		}
	}
	for _, name := range p.TopicNames {
		if err := validateEntityName(name, "Topic"); err != nil {
			return nil, err
		}
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	type countJobResult struct {
		queue         *queueCountResult
		subscriptions []subscriptionCountResult
		failure       *entityCountError
	}
	jobCount := len(p.QueueNames) + len(p.TopicNames)
	results := make(chan countJobResult, jobCount)
	sem := make(chan struct{}, 6)
	var countWg sync.WaitGroup

	for _, queueName := range p.QueueNames {
		queueName := queueName
		countWg.Add(1)
		go func() {
			defer countWg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			resp, err := adminClient.GetQueueRuntimeProperties(ctx, queueName, nil)
			if err != nil {
				results <- countJobResult{failure: &entityCountError{Kind: "queue", Name: queueName, Error: err.Error()}}
				return
			}
			result := queueCountResult{Name: queueName}
			if resp != nil {
				result.Active = int64(resp.ActiveMessageCount)
				result.DLQ = int64(resp.DeadLetterMessageCount)
			}
			results <- countJobResult{queue: &result}
		}()
	}

	for _, topicName := range p.TopicNames {
		topicName := topicName
		countWg.Add(1)
		go func() {
			defer countWg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			pager := adminClient.NewListSubscriptionsRuntimePropertiesPager(topicName, nil)
			subs := []subscriptionCountResult{}
			for pager.More() {
				page, err := pager.NextPage(ctx)
				if err != nil {
					results <- countJobResult{failure: &entityCountError{Kind: "topic", Name: topicName, Error: err.Error()}}
					return
				}
				for _, sub := range page.SubscriptionRuntimeProperties {
					subs = append(subs, subscriptionCountResult{
						Topic:        topicName,
						Subscription: sub.SubscriptionName,
						Active:       int64(sub.ActiveMessageCount),
						DLQ:          int64(sub.DeadLetterMessageCount),
					})
				}
			}
			results <- countJobResult{subscriptions: subs}
		}()
	}

	go func() {
		countWg.Wait()
		close(results)
	}()

	result := entityCountsResult{
		Queues:        []queueCountResult{},
		Subscriptions: []subscriptionCountResult{},
		Errors:        []entityCountError{},
	}
	for job := range results {
		if job.queue != nil {
			result.Queues = append(result.Queues, *job.queue)
		}
		result.Subscriptions = append(result.Subscriptions, job.subscriptions...)
		if job.failure != nil {
			result.Errors = append(result.Errors, *job.failure)
		}
	}
	return result, nil
}

// ─── Shared subscription source helpers ──────────────────────────────────────

type subscriptionSource struct {
	TopicName        string `json:"topicName"`
	SubscriptionName string `json:"subscriptionName"`
}

func (s *subscriptionSource) isSubscription() bool {
	return s.TopicName != "" && s.SubscriptionName != ""
}

func (s *subscriptionSource) label(queueFallback string) string {
	if s.isSubscription() {
		return s.TopicName + "/" + s.SubscriptionName
	}
	return queueFallback
}

type destructiveMessageReceiver interface {
	ReceiveMessages(context.Context, int, *azservicebus.ReceiveMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
	CompleteMessage(context.Context, *azservicebus.ReceivedMessage, *azservicebus.CompleteMessageOptions) error
	Close(context.Context) error
}

type sessionLockReceiver interface {
	SessionID() string
	LockedUntil() time.Time
	RenewSessionLock(context.Context, *azservicebus.RenewSessionLockOptions) error
}

type managedSessionReceiver interface {
	destructiveMessageReceiver
	sessionLockReceiver
}

type sessionLockRenewer struct {
	cancel context.CancelFunc
	done   chan struct{}
	mu     sync.Mutex
	err    error
}

func sessionLockRenewInterval(now, lockedUntil time.Time) time.Duration {
	remaining := lockedUntil.Sub(now)
	if lockedUntil.IsZero() || remaining <= 0 {
		return time.Second
	}
	interval := remaining / 2
	if interval > 20*time.Second {
		interval = 20 * time.Second
	}
	if interval < 100*time.Millisecond {
		interval = 100 * time.Millisecond
	}
	return interval
}

func startSessionLockRenewer(parent context.Context, receiver sessionLockReceiver, maxWaitMs int, interval time.Duration) *sessionLockRenewer {
	ctx, cancel := context.WithCancel(parent)
	renewer := &sessionLockRenewer{
		cancel: cancel,
		done:   make(chan struct{}),
	}
	if maxWaitMs < 1000 {
		maxWaitMs = 1000
	}

	go func() {
		defer close(renewer.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renewCtx, renewCancel := context.WithTimeout(ctx, time.Duration(maxWaitMs)*time.Millisecond)
				err := receiver.RenewSessionLock(renewCtx, nil)
				renewCancel()
				if err != nil {
					if ctx.Err() != nil {
						return
					}
					renewer.mu.Lock()
					renewer.err = fmt.Errorf("renew session %q lock: %w", receiver.SessionID(), err)
					renewer.mu.Unlock()
					return
				}
			}
		}
	}()

	return renewer
}

func (r *sessionLockRenewer) currentError() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.err
}

func (r *sessionLockRenewer) stop() error {
	r.cancel()
	<-r.done
	return r.currentError()
}

func sourceRequiresSession(ctx context.Context, connectionString, queueName string, source subscriptionSource) (bool, error) {
	adminClient, err := getAdminClient(connectionString)
	if err != nil {
		return false, err
	}
	if source.isSubscription() {
		resp, err := adminClient.GetSubscription(ctx, source.TopicName, source.SubscriptionName, nil)
		if err != nil {
			return false, err
		}
		if resp == nil {
			return false, fmt.Errorf("subscription %q was not found", source.label(queueName))
		}
		return resp.RequiresSession != nil && *resp.RequiresSession, nil
	}
	resp, err := adminClient.GetQueue(ctx, queueName, nil)
	if err != nil {
		return false, err
	}
	if resp == nil {
		return false, fmt.Errorf("queue %q was not found", queueName)
	}
	return resp.RequiresSession != nil && *resp.RequiresSession, nil
}

func acceptNextSessionForSource(
	ctx context.Context,
	client *azservicebus.Client,
	queueName string,
	source subscriptionSource,
	subQueue azservicebus.SubQueue,
) (*azservicebus.SessionReceiver, error) {
	sessionQueueName, topicName, subscriptionName := sessionReceiverEntityNames(queueName, source, subQueue)
	if topicName != "" {
		return client.AcceptNextSessionForSubscription(ctx, topicName, subscriptionName, nil)
	}
	return client.AcceptNextSessionForQueue(ctx, sessionQueueName, nil)
}

func sessionReceiverEntityNames(
	queueName string,
	source subscriptionSource,
	subQueue azservicebus.SubQueue,
) (sessionQueueName string, topicName string, subscriptionName string) {
	if source.isSubscription() {
		return "", source.TopicName, entityNameWithSubQueue(source.SubscriptionName, subQueue)
	}
	return entityNameWithSubQueue(queueName, subQueue), "", ""
}

func isNoAvailableSessionError(err error) bool {
	var serviceBusErr *azservicebus.Error
	return errors.Is(err, context.DeadlineExceeded) ||
		(errors.As(err, &serviceBusErr) && serviceBusErr.Code == azservicebus.CodeTimeout)
}

func consumeAvailableSessions(
	requestCtx context.Context,
	maxWaitMs int,
	drainWaitMs int,
	label string,
	accept func(context.Context) (managedSessionReceiver, error),
	consume func(managedSessionReceiver, string) (int, error),
) (int, error) {
	total := 0
	emptySessions := map[string]struct{}{}
	for {
		waitMs := maxWaitMs
		if total > 0 {
			waitMs = drainWaitMs
		}
		acceptCtx, acceptCancel := context.WithTimeout(requestCtx, time.Duration(waitMs)*time.Millisecond)
		receiver, err := accept(acceptCtx)
		acceptCancel()
		if err != nil {
			if requestCtx.Err() != nil {
				return total, requestCtx.Err()
			}
			if isNoAvailableSessionError(err) {
				return total, nil
			}
			return total, fmt.Errorf("accept next session for %s: %w", label, err)
		}

		sessionID := receiver.SessionID()
		renewer := startSessionLockRenewer(
			requestCtx,
			receiver,
			maxWaitMs,
			sessionLockRenewInterval(time.Now(), receiver.LockedUntil()),
		)
		consumed, consumeErr := consume(receiver, fmt.Sprintf("%s (session %q)", label, sessionID))
		renewErr := renewer.stop()
		closeWithTimeout(receiver)
		total += consumed

		if consumeErr != nil {
			return total, consumeErr
		}
		if renewErr != nil {
			return total, renewErr
		}
		if consumed == 0 {
			if _, seen := emptySessions[sessionID]; seen {
				return total, fmt.Errorf("session %q in %s was accepted repeatedly without receivable messages; stopping to avoid an infinite loop", sessionID, label)
			}
			emptySessions[sessionID] = struct{}{}
		} else {
			delete(emptySessions, sessionID)
		}
	}
}

func completeReceivedMessages(
	requestCtx context.Context,
	receiver destructiveMessageReceiver,
	messages []*azservicebus.ReceivedMessage,
	env map[string]string,
	maxWaitMs int,
	concurrency int,
) (int, error) {
	if concurrency <= 1 {
		completed := 0
		for _, msg := range messages {
			completeCtx, completeCancel := cancellableOperationContext(requestCtx, env, maxWaitMs)
			err := receiver.CompleteMessage(completeCtx, msg, nil)
			completeCancel()
			if err != nil {
				return completed, fmt.Errorf("complete message error: %w", err)
			}
			completed++
		}
		return completed, nil
	}

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	errCh := make(chan error, len(messages))
	completedCh := make(chan struct{}, len(messages))
	for _, msg := range messages {
		wg.Add(1)
		go func(m *azservicebus.ReceivedMessage) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			completeCtx, completeCancel := cancellableOperationContext(requestCtx, env, maxWaitMs)
			defer completeCancel()
			if err := receiver.CompleteMessage(completeCtx, m, nil); err != nil {
				errCh <- fmt.Errorf("complete message error: %w", err)
				return
			}
			completedCh <- struct{}{}
		}(msg)
	}
	wg.Wait()
	close(errCh)
	close(completedCh)

	completed := 0
	for range completedCh {
		completed++
	}
	if err := <-errCh; err != nil {
		return completed, err
	}
	return completed, nil
}
