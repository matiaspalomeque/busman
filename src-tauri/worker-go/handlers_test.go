package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

type fakePeekRequest struct {
	count int
	start *int64
}

type fakePeekMessageReceiver struct {
	messages []*azservicebus.ReceivedMessage
	requests []fakePeekRequest
}

func (r *fakePeekMessageReceiver) PeekMessages(_ context.Context, count int, opts *azservicebus.PeekMessagesOptions) ([]*azservicebus.ReceivedMessage, error) {
	var start *int64
	if opts != nil && opts.FromSequenceNumber != nil {
		value := *opts.FromSequenceNumber
		start = &value
	}
	r.requests = append(r.requests, fakePeekRequest{count: count, start: start})

	result := make([]*azservicebus.ReceivedMessage, 0, count)
	for _, msg := range r.messages {
		if start != nil && (msg.SequenceNumber == nil || *msg.SequenceNumber < *start) {
			continue
		}
		result = append(result, msg)
		if len(result) == count {
			break
		}
	}
	return result, nil
}

func peekTestMessages(prefix string, sequenceNumbers ...int64) []*azservicebus.ReceivedMessage {
	messages := make([]*azservicebus.ReceivedMessage, 0, len(sequenceNumbers))
	for _, sequenceNumber := range sequenceNumbers {
		seq := sequenceNumber
		messages = append(messages, &azservicebus.ReceivedMessage{
			MessageID:      fmt.Sprintf("%s-%d", prefix, sequenceNumber),
			SequenceNumber: &seq,
			Body:           []byte(fmt.Sprintf("%s body", prefix)),
		})
	}
	return messages
}

type fakeSingleReceiveStep struct {
	messages []*azservicebus.ReceivedMessage
	err      error
	delay    time.Duration
	after    func()
}

type fakeSingleMessageActionReceiver struct {
	mu sync.Mutex

	receiveSteps     []fakeSingleReceiveStep
	receiveCalls     int
	events           []string
	abandoned        []int64
	completed        []int64
	renewed          []int64
	completeDelay    time.Duration
	requireValidLock bool
	abandonErr       map[int64]error
	completeErr      map[int64]error
	renewErr         map[int64]error
	renewHook        func(context.Context, int64) error
}

func messageSequence(msg *azservicebus.ReceivedMessage) int64 {
	if msg == nil || msg.SequenceNumber == nil {
		return 0
	}
	return *msg.SequenceNumber
}

func (f *fakeSingleMessageActionReceiver) ReceiveMessages(ctx context.Context, _ int, _ *azservicebus.ReceiveMessagesOptions) ([]*azservicebus.ReceivedMessage, error) {
	f.mu.Lock()
	call := f.receiveCalls
	f.receiveCalls++
	f.events = append(f.events, fmt.Sprintf("receive:%d", call+1))
	if call >= len(f.receiveSteps) {
		f.mu.Unlock()
		return nil, nil
	}
	step := f.receiveSteps[call]
	f.mu.Unlock()

	if step.delay > 0 {
		timer := time.NewTimer(step.delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	if step.after != nil {
		step.after()
	}
	return step.messages, step.err
}

func (f *fakeSingleMessageActionReceiver) ReceiveDeferredMessages(context.Context, []int64, *azservicebus.ReceiveDeferredMessagesOptions) ([]*azservicebus.ReceivedMessage, error) {
	return nil, nil
}

func (f *fakeSingleMessageActionReceiver) CompleteMessage(ctx context.Context, msg *azservicebus.ReceivedMessage, _ *azservicebus.CompleteMessageOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	delay := f.completeDelay
	f.mu.Unlock()
	if delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	sequence := messageSequence(msg)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completed = append(f.completed, sequence)
	f.events = append(f.events, fmt.Sprintf("complete:%d", sequence))
	if f.requireValidLock && (msg.LockedUntil == nil || !time.Now().Before(*msg.LockedUntil)) {
		return errors.New("message lock expired before completion")
	}
	return f.completeErr[sequence]
}

func (f *fakeSingleMessageActionReceiver) AbandonMessage(ctx context.Context, msg *azservicebus.ReceivedMessage, _ *azservicebus.AbandonMessageOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sequence := messageSequence(msg)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.abandoned = append(f.abandoned, sequence)
	f.events = append(f.events, fmt.Sprintf("abandon:%d", sequence))
	return f.abandonErr[sequence]
}

func (f *fakeSingleMessageActionReceiver) RenewMessageLock(ctx context.Context, msg *azservicebus.ReceivedMessage, _ *azservicebus.RenewMessageLockOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sequence := messageSequence(msg)
	f.mu.Lock()
	f.renewed = append(f.renewed, sequence)
	f.events = append(f.events, fmt.Sprintf("renew:%d", sequence))
	hook := f.renewHook
	renewErr := f.renewErr[sequence]
	f.mu.Unlock()
	if hook != nil {
		if err := hook(ctx, sequence); err != nil {
			return err
		}
	}
	if renewErr != nil {
		return renewErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	lockedUntil := time.Now().Add(time.Minute)
	f.mu.Lock()
	msg.LockedUntil = &lockedUntil
	f.mu.Unlock()
	return nil
}

func (f *fakeSingleMessageActionReceiver) snapshot() (events []string, abandoned []int64, completed []int64, renewed []int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...),
		append([]int64(nil), f.abandoned...),
		append([]int64(nil), f.completed...),
		append([]int64(nil), f.renewed...)
}

type fakeSingleMessageSender struct {
	mu        sync.Mutex
	sent      int
	sendErr   error
	delay     time.Duration
	started   chan struct{}
	startOnce sync.Once
	messages  []*azservicebus.Message
}

func (f *fakeSingleMessageSender) SendMessage(ctx context.Context, msg *azservicebus.Message, _ *azservicebus.SendMessageOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.started != nil {
		f.startOnce.Do(func() { close(f.started) })
	}
	if f.delay > 0 {
		timer := time.NewTimer(f.delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent++
	f.messages = append(f.messages, msg)
	return f.sendErr
}

func TestSequenceNumberDecimalStringBoundaries(t *testing.T) {
	tests := []struct {
		name  string
		value int64
		want  string
	}{
		{name: "two to the fifty-third plus one", value: 9007199254740993, want: "9007199254740993"},
		{name: "partition encoded", value: 9288674231451771, want: "9288674231451771"},
		{name: "signed int64 maximum", value: 9223372036854775807, want: "9223372036854775807"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value := tt.value
			record := peekedMessageRecord(&azservicebus.ReceivedMessage{
				MessageID:      "boundary",
				SequenceNumber: &value,
			}, "Normal Queue: orders")
			if got := record["sequenceNumber"]; got != tt.want {
				t.Fatalf("sequenceNumber = %#v, want decimal string %q", got, tt.want)
			}

			encoded, err := json.Marshal(record)
			if err != nil {
				t.Fatalf("marshal record: %v", err)
			}
			if !strings.Contains(string(encoded), `"sequenceNumber":"`+tt.want+`"`) {
				t.Fatalf("JSON sequence number was not encoded as an exact string: %s", encoded)
			}
		})
	}
}

func TestParseSequenceNumberRequiresCanonicalNonNegativeInt64(t *testing.T) {
	for _, value := range []string{"0", "9007199254740993", "9288674231451771", "9223372036854775807"} {
		got, err := parseSequenceNumber(value)
		if err != nil {
			t.Fatalf("parse valid sequence number %q: %v", value, err)
		}
		if fmt.Sprintf("%d", got) != value {
			t.Fatalf("parsed sequence number = %d, want %s", got, value)
		}
	}

	for _, value := range []string{"", "-1", "+1", "01", " 1", "1 ", "1.0", "9223372036854775808"} {
		if _, err := parseSequenceNumber(value); err == nil {
			t.Fatalf("parseSequenceNumber(%q) unexpectedly succeeded", value)
		}
	}
}

func TestSingleMessageActionParamsPreserveSequenceNumberJSONInteger(t *testing.T) {
	for _, value := range []string{"9007199254740993", "9288674231451771", "9223372036854775807"} {
		var params singleMessageActionParams
		if err := json.Unmarshal([]byte(`{"sequenceNumber":`+value+`}`), &params); err != nil {
			t.Fatalf("unmarshal sequence number %s: %v", value, err)
		}
		if fmt.Sprintf("%d", params.SequenceNumber) != value {
			t.Fatalf("sequence number = %d, want %s", params.SequenceNumber, value)
		}
	}
}

func TestPeekMessagesStopsBeforeSequenceNumberOverflow(t *testing.T) {
	const maxSequenceNumber int64 = 9223372036854775807
	receiver := &fakePeekMessageReceiver{messages: peekTestMessages("max", maxSequenceNumber)}

	messages, canAdvance, err := peekMessagesForSource(
		context.Background(), receiver, 2, nil, 1000, "Normal Queue: orders", nil,
	)
	if err != nil {
		t.Fatalf("peek messages: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("messages = %d, want exactly the max-sequence message once", len(messages))
	}
	if canAdvance {
		t.Fatal("cursor unexpectedly advanced beyond signed int64 maximum")
	}
	if len(receiver.requests) != 1 {
		t.Fatalf("peek requests = %d, want 1", len(receiver.requests))
	}
	if got := messages[0]["sequenceNumber"]; got != "9223372036854775807" {
		t.Fatalf("sequenceNumber = %#v, want exact max string", got)
	}
}

func TestPeekMessagesResultDoesNotPersistPayloadSnapshots(t *testing.T) {
	dir := t.TempDir()
	previousDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("get working directory: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("change working directory: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previousDir); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	})

	for _, messages := range [][]map[string]any{
		nil,
		{{"messageId": "message-1", "body": "private payload"}},
	} {
		result := peekMessagesResult(messages)
		if _, ok := result["filename"]; ok {
			t.Fatal("peek result unexpectedly contains a persisted filename")
		}
		if _, ok := result["savedAt"]; ok {
			t.Fatal("peek result unexpectedly contains a persistence timestamp")
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read temporary browse directory: %v", err)
		}
		if len(entries) != 0 {
			t.Fatalf("ordinary browse created files: %v", entries)
		}
	}
}

func TestPeekMessagesPagePolicy(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    int
		wantErr bool
	}{
		{name: "default", value: "", want: 10},
		{name: "exact limit", value: "5000", want: maxPeekPageMessages},
		{name: "over limit", value: "5001", wantErr: true},
		{name: "zero", value: "0", wantErr: true},
		{name: "malformed", value: "lots", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parsePeekCount(tt.value)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parsePeekCount(%q) unexpectedly returned %d", tt.value, got)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("parsePeekCount(%q) = %d, %v; want %d", tt.value, got, err, tt.want)
			}
		})
	}
}

func TestPeekMessagesBothSourcesHaveIndependentPageBudgets(t *testing.T) {
	normal := &fakePeekMessageReceiver{messages: peekTestMessages("normal", 1, 2, 3)}
	dlq := &fakePeekMessageReceiver{messages: peekTestMessages("dlq", 101)}

	normalMessages, _, err := peekMessagesForSource(
		context.Background(), normal, 2, nil, 1000, "Normal Queue: orders", nil,
	)
	if err != nil {
		t.Fatalf("peek normal messages: %v", err)
	}
	dlqMessages, _, err := peekMessagesForSource(
		context.Background(), dlq, 2, nil, 1000, "Dead Letter Queue: orders", nil,
	)
	if err != nil {
		t.Fatalf("peek dead-letter messages: %v", err)
	}

	if len(normalMessages) != 2 {
		t.Fatalf("normal page size = %d, want 2", len(normalMessages))
	}
	if len(dlqMessages) != 1 {
		t.Fatalf("dead-letter page size = %d, want 1", len(dlqMessages))
	}
	if got := dlqMessages[0]["sourceSubQueue"]; got != "deadLetter" {
		t.Fatalf("dead-letter source label = %v, want deadLetter", got)
	}
	if len(normal.requests) == 0 || normal.requests[0].count != 2 {
		t.Fatalf("normal requests = %#v, want an independent count-2 request", normal.requests)
	}
	if len(dlq.requests) == 0 || dlq.requests[0].count != 2 {
		t.Fatalf("dead-letter requests = %#v, want an independent count-2 request", dlq.requests)
	}
}

func TestPeekMessagesBothSourcesAllowEitherSideToBeEmpty(t *testing.T) {
	tests := []struct {
		name       string
		normalSeqs []int64
		dlqSeqs    []int64
		wantNormal int
		wantDLQ    int
	}{
		{name: "normal empty", dlqSeqs: []int64{101, 102}, wantDLQ: 2},
		{name: "dead letter empty", normalSeqs: []int64{1, 2}, wantNormal: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			normal := &fakePeekMessageReceiver{messages: peekTestMessages("normal", tt.normalSeqs...)}
			dlq := &fakePeekMessageReceiver{messages: peekTestMessages("dlq", tt.dlqSeqs...)}

			normalMessages, _, err := peekMessagesForSource(
				context.Background(), normal, 2, nil, 1000, "Normal Queue: orders", nil,
			)
			if err != nil {
				t.Fatalf("peek normal messages: %v", err)
			}
			dlqMessages, _, err := peekMessagesForSource(
				context.Background(), dlq, 2, nil, 1000, "Dead Letter Queue: orders", nil,
			)
			if err != nil {
				t.Fatalf("peek dead-letter messages: %v", err)
			}

			if len(normalMessages) != tt.wantNormal || len(dlqMessages) != tt.wantDLQ {
				t.Fatalf(
					"page sizes = normal %d, dead letter %d; want normal %d, dead letter %d",
					len(normalMessages), len(dlqMessages), tt.wantNormal, tt.wantDLQ,
				)
			}
		})
	}
}

func TestPeekMessagesBothSourcesUseIndependentStartCursors(t *testing.T) {
	normal := &fakePeekMessageReceiver{messages: peekTestMessages("normal", 10, 11, 12)}
	dlq := &fakePeekMessageReceiver{messages: peekTestMessages("dlq", 100, 101, 102)}
	normalStart := int64(11)
	dlqStart := int64(101)

	normalMessages, _, err := peekMessagesForSource(
		context.Background(), normal, 2, &normalStart, 1000, "Normal Queue: orders", nil,
	)
	if err != nil {
		t.Fatalf("peek normal messages: %v", err)
	}
	dlqMessages, _, err := peekMessagesForSource(
		context.Background(), dlq, 2, &dlqStart, 1000, "Dead Letter Queue: orders", nil,
	)
	if err != nil {
		t.Fatalf("peek dead-letter messages: %v", err)
	}

	if got := normalMessages[0]["messageId"]; got != "normal-11" {
		t.Fatalf("first normal message = %v, want normal-11", got)
	}
	if got := dlqMessages[0]["messageId"]; got != "dlq-101" {
		t.Fatalf("first dead-letter message = %v, want dlq-101", got)
	}
	if normal.requests[0].start == nil || *normal.requests[0].start != normalStart {
		t.Fatalf("normal start cursor = %#v, want %d", normal.requests[0].start, normalStart)
	}
	if dlq.requests[0].start == nil || *dlq.requests[0].start != dlqStart {
		t.Fatalf("dead-letter start cursor = %#v, want %d", dlq.requests[0].start, dlqStart)
	}
}

func TestBoundedIntFromEnvClampsUnsafeValues(t *testing.T) {
	if got := boundedIntFromEnv(map[string]string{"COUNT": "0"}, "COUNT", 50, 100); got != 50 {
		t.Fatalf("zero value = %d, want safe default 50", got)
	}
	if got := boundedIntFromEnv(map[string]string{"COUNT": "500"}, "COUNT", 50, 100); got != 100 {
		t.Fatalf("large value = %d, want 100", got)
	}
}

func TestValidateMoveSourceDest(t *testing.T) {
	tests := []struct {
		name           string
		source         string
		dest           string
		mode           string
		isSubscription bool
		expectErr      bool
	}{
		{
			name:      "normal mode blocks same queue",
			source:    "queue1",
			dest:      "queue1",
			mode:      "normal",
			expectErr: true,
		},
		{
			name:      "both mode blocks same queue",
			source:    "queue1",
			dest:      "queue1",
			mode:      "both",
			expectErr: true,
		},
		{
			name:      "dlq mode allows same queue",
			source:    "queue1",
			dest:      "queue1",
			mode:      "dlq",
			expectErr: false,
		},
		{
			name:      "normal mode allows different queues",
			source:    "queue1",
			dest:      "queue2",
			mode:      "normal",
			expectErr: false,
		},
		{
			name:      "both mode allows different queues",
			source:    "queue1",
			dest:      "queue2",
			mode:      "both",
			expectErr: false,
		},
		{
			name:      "dlq mode allows different queues",
			source:    "queue1",
			dest:      "queue2",
			mode:      "dlq",
			expectErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateMoveSourceDest(tt.source, tt.dest, tt.mode, tt.isSubscription)
			if tt.expectErr && err == nil {
				t.Fatalf("expected an error, got nil")
			}
			if !tt.expectErr && err != nil {
				t.Fatalf("expected no error, got: %v", err)
			}
		})
	}
}

func TestMoveMessagesDestinationKind(t *testing.T) {
	tests := []struct {
		name    string
		params  moveMessagesParams
		want    messageDestination
		wantErr bool
	}{
		{
			name:   "bulk move defaults to queue",
			params: moveMessagesParams{DestQueue: "archive"},
			want:   messageDestination{Name: "archive", Kind: messageDestinationQueue},
		},
		{
			name:   "subscription republish targets topic",
			params: moveMessagesParams{DestQueue: "events", DestinationKind: "topic"},
			want:   messageDestination{Name: "events", Kind: messageDestinationTopic},
		},
		{
			name:    "unknown kind is rejected",
			params:  moveMessagesParams{DestQueue: "events", DestinationKind: "namespace"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.params.destination()
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected destination error")
				}
				return
			}
			if err != nil {
				t.Fatalf("destination returned error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("destination = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestSingleMessageDestinationKind(t *testing.T) {
	tests := []struct {
		name   string
		params singleMessageActionParams
		want   messageDestination
	}{
		{
			name:   "queue replay",
			params: singleMessageActionParams{Action: "replay", QueueName: "orders"},
			want:   messageDestination{Name: "orders", Kind: messageDestinationQueue},
		},
		{
			name: "subscription replay",
			params: singleMessageActionParams{
				Action:    "replay",
				DestTopic: "events",
				subscriptionSource: subscriptionSource{
					TopicName:        "events",
					SubscriptionName: "processor",
				},
			},
			want: messageDestination{Name: "events", Kind: messageDestinationTopic},
		},
		{
			name:   "move to queue",
			params: singleMessageActionParams{Action: "move", DestQueue: "archive"},
			want:   messageDestination{Name: "archive", Kind: messageDestinationQueue},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.params.destination(); got != tt.want {
				t.Fatalf("destination = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestResolveDrainReceiveWaitMs(t *testing.T) {
	tests := []struct {
		name      string
		env       map[string]string
		maxWaitMs int
		want      int
	}{
		{
			name:      "uses drain default when no env",
			env:       map[string]string{},
			maxWaitMs: 60000,
			want:      3000,
		},
		{
			name: "respects explicit drain wait",
			env: map[string]string{
				"DRAIN_IDLE_WAIT_TIME_IN_MS": "1500",
			},
			maxWaitMs: 60000,
			want:      1500,
		},
		{
			name: "caps drain wait to max wait",
			env: map[string]string{
				"DRAIN_IDLE_WAIT_TIME_IN_MS": "5000",
			},
			maxWaitMs: 1000,
			want:      1000,
		},
		{
			name: "falls back to drain default for invalid values",
			env: map[string]string{
				"DRAIN_IDLE_WAIT_TIME_IN_MS": "abc",
			},
			maxWaitMs: 60000,
			want:      3000,
		},
		{
			name:      "caps default drain wait when max wait is smaller",
			env:       map[string]string{},
			maxWaitMs: 1000,
			want:      1000,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveDrainReceiveWaitMs(tt.env, tt.maxWaitMs)
			if got != tt.want {
				t.Fatalf("expected %d, got %d", tt.want, got)
			}
		})
	}
}

func TestParseBoolOrDefault(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		def  bool
		want bool
	}{
		{name: "empty uses default true", raw: "", def: true, want: true},
		{name: "empty uses default false", raw: "", def: false, want: false},
		{name: "true literal", raw: "true", def: false, want: true},
		{name: "false literal", raw: "false", def: true, want: false},
		{name: "one literal", raw: "1", def: false, want: true},
		{name: "zero literal", raw: "0", def: true, want: false},
		{name: "mixed case", raw: "YeS", def: false, want: true},
		{name: "invalid uses default", raw: "maybe", def: true, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseBoolOrDefault(tt.raw, tt.def)
			if got != tt.want {
				t.Fatalf("expected %v, got %v", tt.want, got)
			}
		})
	}
}

func TestGetAdminClientCachesInstance(t *testing.T) {
	// Clear cache before test
	adminClientCache.Range(func(key, _ any) bool {
		adminClientCache.Delete(key)
		return true
	})

	// Use a dummy connection string — NewClientFromConnectionString only
	// validates format, not reachability.
	cs := "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA=="

	c1, err := getAdminClient(cs)
	if err != nil {
		t.Fatalf("first call failed: %v", err)
	}
	c2, err := getAdminClient(cs)
	if err != nil {
		t.Fatalf("second call failed: %v", err)
	}

	if c1 != c2 {
		t.Fatal("expected same cached client instance, got different pointers")
	}

	// Different connection string should give a different client.
	cs2 := "Endpoint=sb://other.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=b3RoZXI="
	c3, err := getAdminClient(cs2)
	if err != nil {
		t.Fatalf("third call failed: %v", err)
	}
	if c1 == c3 {
		t.Fatal("expected different client for different connection string")
	}
}

func TestHandleGetTopicSubscriptionCountsValidation(t *testing.T) {
	tests := []struct {
		name    string
		params  map[string]any
		wantErr bool
	}{
		{
			name:    "missing env",
			params:  map[string]any{"topicName": "t1"},
			wantErr: true,
		},
		{
			name: "missing topic name",
			params: map[string]any{
				"env":       map[string]string{"SERVICE_BUS_CONNECTION_STRING": "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA=="},
				"topicName": "",
			},
			wantErr: true,
		},
		{
			name: "invalid topic name characters",
			params: map[string]any{
				"env":       map[string]string{"SERVICE_BUS_CONNECTION_STRING": "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA=="},
				"topicName": "invalid topic!",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(tt.params)
			_, err := handleGetTopicSubscriptionCounts(raw)
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error, got: %v", err)
			}
		})
	}
}

func TestHandleRepublishSubscriptionDlqValidation(t *testing.T) {
	tests := []struct {
		name    string
		params  map[string]any
		wantErr bool
	}{
		{
			name: "missing topic name",
			params: map[string]any{
				"env":              map[string]string{"SERVICE_BUS_CONNECTION_STRING": "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA=="},
				"topicName":        "",
				"subscriptionName": "sub1",
			},
			wantErr: true,
		},
		{
			name: "missing subscription name",
			params: map[string]any{
				"env":              map[string]string{"SERVICE_BUS_CONNECTION_STRING": "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA=="},
				"topicName":        "topic1",
				"subscriptionName": "",
			},
			wantErr: true,
		},
		{
			name: "invalid subscription name",
			params: map[string]any{
				"env":              map[string]string{"SERVICE_BUS_CONNECTION_STRING": "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA=="},
				"topicName":        "topic1",
				"subscriptionName": "bad sub!",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(tt.params)
			_, err := handleRepublishSubscriptionDlq(context.Background(), raw)
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error, got: %v", err)
			}
		})
	}
}

func TestScanActiveSingleMessageHoldsNonTargetsUntilTargetHandled(t *testing.T) {
	receiver := &fakeSingleMessageActionReceiver{
		receiveSteps: []fakeSingleReceiveStep{
			{messages: peekTestMessages("active", 1, 2)},
			{messages: peekTestMessages("active", 3, 4)},
		},
	}
	params := singleMessageActionParams{Action: "delete", SequenceNumber: 3}
	result, err := scanActiveSingleMessage(
		context.Background(),
		receiver,
		receiver,
		nil,
		3,
		activeSingleMessageScanConfig{
			ScanBudget:         4,
			BatchSize:          2,
			MaxWaitMs:          1000,
			CleanupConcurrency: 4,
		},
		func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
			return performSingleMessageTargetAction(actionCtx, params, receiver, nil, target, false, 1000, nil)
		},
	)
	if err != nil {
		t.Fatalf("scan active target: %v", err)
	}
	if !result.Found || !result.TargetHandled || result.Scanned != 4 {
		t.Fatalf("unexpected scan result: %#v", result)
	}

	events, abandoned, completed, _ := receiver.snapshot()
	if fmt.Sprint(completed) != fmt.Sprint([]int64{3}) {
		t.Fatalf("completed = %v, want [3]", completed)
	}
	wantAbandoned := map[int64]int{1: 1, 2: 1, 4: 1}
	gotAbandoned := map[int64]int{}
	for _, sequence := range abandoned {
		gotAbandoned[sequence]++
	}
	if fmt.Sprint(gotAbandoned) != fmt.Sprint(wantAbandoned) {
		t.Fatalf("abandoned counts = %v, want %v", gotAbandoned, wantAbandoned)
	}
	completeIndex := -1
	secondReceiveIndex := -1
	firstAbandonIndex := len(events)
	for i, event := range events {
		switch {
		case event == "receive:2":
			secondReceiveIndex = i
		case event == "complete:3":
			completeIndex = i
		case strings.HasPrefix(event, "abandon:") && firstAbandonIndex == len(events):
			firstAbandonIndex = i
		}
	}
	if secondReceiveIndex < 0 || completeIndex < secondReceiveIndex || firstAbandonIndex < completeIndex {
		t.Fatalf("non-targets were released before the forward scan and target action completed: %v", events)
	}
}

func TestScanActiveSingleMessageSessionCleanupPreservesReceiveOrder(t *testing.T) {
	receiver := &fakeSingleMessageActionReceiver{
		receiveSteps: []fakeSingleReceiveStep{
			{messages: peekTestMessages("session", 1, 2, 3, 4)},
		},
	}
	params := singleMessageActionParams{Action: "delete", SequenceNumber: 3}
	result, err := scanActiveSingleMessage(
		context.Background(),
		receiver,
		nil,
		nil,
		3,
		activeSingleMessageScanConfig{
			ScanBudget:         4,
			BatchSize:          4,
			MaxWaitMs:          1000,
			CleanupConcurrency: 1,
		},
		func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
			return performSingleMessageTargetAction(actionCtx, params, receiver, nil, target, false, 1000, nil)
		},
	)
	if err != nil {
		t.Fatalf("scan session target: %v", err)
	}
	if !result.TargetHandled {
		t.Fatalf("target was not handled: %#v", result)
	}
	_, abandoned, completed, _ := receiver.snapshot()
	if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1, 2, 4}) {
		t.Fatalf("session abandon order = %v, want [1 2 4]", abandoned)
	}
	if fmt.Sprint(completed) != fmt.Sprint([]int64{3}) {
		t.Fatalf("completed = %v, want [3]", completed)
	}
}

func TestScanActiveSingleMessageSessionLockFailureCleansUpInOrder(t *testing.T) {
	receiver := &fakeSingleMessageActionReceiver{
		receiveSteps: []fakeSingleReceiveStep{
			{messages: peekTestMessages("session", 1, 2, 3)},
		},
	}
	lockChecks := 0
	result, err := scanActiveSingleMessage(
		context.Background(),
		receiver,
		nil,
		nil,
		3,
		activeSingleMessageScanConfig{
			ScanBudget:         3,
			BatchSize:          3,
			MaxWaitMs:          1000,
			CleanupConcurrency: 1,
			ExternalLockError: func() error {
				lockChecks++
				if lockChecks > 1 {
					return errors.New("session lock expired")
				}
				return nil
			},
		},
		func(context.Context, *azservicebus.ReceivedMessage) error {
			t.Fatal("target must not be handled after the session lock expires")
			return nil
		},
	)
	if err == nil || !strings.Contains(err.Error(), "session lock expired") {
		t.Fatalf("expected session-lock error, got %v", err)
	}
	if result.TargetHandled {
		t.Fatalf("target unexpectedly handled: %#v", result)
	}
	_, abandoned, completed, _ := receiver.snapshot()
	if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1, 2, 3}) {
		t.Fatalf("session cleanup order = %v, want [1 2 3]", abandoned)
	}
	if len(completed) != 0 {
		t.Fatalf("unexpected completed messages: %v", completed)
	}
}

func TestScanActiveSingleMessageNotFoundReleasesEachHeldMessageOnce(t *testing.T) {
	receiver := &fakeSingleMessageActionReceiver{
		receiveSteps: []fakeSingleReceiveStep{
			{messages: peekTestMessages("active", 1, 2)},
			{},
		},
	}
	result, err := scanActiveSingleMessage(
		context.Background(),
		receiver,
		receiver,
		nil,
		99,
		activeSingleMessageScanConfig{
			ScanBudget:         4,
			BatchSize:          2,
			MaxWaitMs:          1000,
			CleanupConcurrency: 1,
		},
		func(context.Context, *azservicebus.ReceivedMessage) error {
			t.Fatal("unexpected target callback")
			return nil
		},
	)
	if err != nil {
		t.Fatalf("not-found scan cleanup: %v", err)
	}
	if result.Found || result.Scanned != 2 {
		t.Fatalf("unexpected scan result: %#v", result)
	}
	_, abandoned, completed, _ := receiver.snapshot()
	if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1, 2}) {
		t.Fatalf("abandoned = %v, want [1 2]", abandoned)
	}
	if len(completed) != 0 {
		t.Fatalf("unexpected completed messages: %v", completed)
	}
}

func TestScanActiveSingleMessageCleansUpOnTargetActionErrors(t *testing.T) {
	t.Run("send failure abandons target and held messages once", func(t *testing.T) {
		receiver := &fakeSingleMessageActionReceiver{
			receiveSteps: []fakeSingleReceiveStep{{messages: peekTestMessages("active", 1, 3, 2)}},
		}
		sender := &fakeSingleMessageSender{sendErr: errors.New("send failed")}
		params := singleMessageActionParams{Action: "move", SequenceNumber: 3}
		_, err := scanActiveSingleMessage(
			context.Background(),
			receiver,
			receiver,
			nil,
			3,
			activeSingleMessageScanConfig{ScanBudget: 3, BatchSize: 3, MaxWaitMs: 1000, CleanupConcurrency: 1},
			func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
				return performSingleMessageTargetAction(actionCtx, params, receiver, sender, target, false, 1000, nil)
			},
		)
		if err == nil || !strings.Contains(err.Error(), "send message error") {
			t.Fatalf("expected send error, got %v", err)
		}
		_, abandoned, completed, _ := receiver.snapshot()
		if fmt.Sprint(abandoned) != fmt.Sprint([]int64{3, 1, 2}) {
			t.Fatalf("abandoned = %v, want target then held messages [3 1 2]", abandoned)
		}
		if len(completed) != 0 {
			t.Fatalf("unexpected completed messages: %v", completed)
		}
	})

	t.Run("source settlement failure reports ambiguity and releases non-targets", func(t *testing.T) {
		receiver := &fakeSingleMessageActionReceiver{
			receiveSteps: []fakeSingleReceiveStep{{messages: peekTestMessages("active", 1, 3, 2)}},
			completeErr:  map[int64]error{3: errors.New("settlement failed")},
		}
		sender := &fakeSingleMessageSender{}
		params := singleMessageActionParams{Action: "move", SequenceNumber: 3}
		ambiguousReported := false
		_, err := scanActiveSingleMessage(
			context.Background(),
			receiver,
			receiver,
			nil,
			3,
			activeSingleMessageScanConfig{ScanBudget: 3, BatchSize: 3, MaxWaitMs: 1000, CleanupConcurrency: 1},
			func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
				return performSingleMessageTargetAction(
					actionCtx, params, receiver, sender, target, false, 1000,
					func(error) { ambiguousReported = true },
				)
			},
		)
		if err == nil || !strings.Contains(err.Error(), "duplicate delivery is possible") {
			t.Fatalf("expected ambiguous settlement error, got %v", err)
		}
		if !ambiguousReported {
			t.Fatal("expected ambiguous settlement callback")
		}
		_, abandoned, completed, _ := receiver.snapshot()
		if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1, 2}) {
			t.Fatalf("abandoned = %v, want held messages [1 2]", abandoned)
		}
		if fmt.Sprint(completed) != fmt.Sprint([]int64{3}) {
			t.Fatalf("completion attempts = %v, want [3]", completed)
		}
		if sender.sent != 1 {
			t.Fatalf("send attempts = %d, want 1", sender.sent)
		}
	})

	t.Run("cleanup failure attempts every held message", func(t *testing.T) {
		receiver := &fakeSingleMessageActionReceiver{
			receiveSteps: []fakeSingleReceiveStep{{messages: peekTestMessages("active", 1, 3, 2)}},
			abandonErr:   map[int64]error{1: errors.New("lock lost")},
		}
		params := singleMessageActionParams{Action: "delete", SequenceNumber: 3}
		result, err := scanActiveSingleMessage(
			context.Background(),
			receiver,
			receiver,
			nil,
			3,
			activeSingleMessageScanConfig{ScanBudget: 3, BatchSize: 3, MaxWaitMs: 1000, CleanupConcurrency: 1},
			func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
				return performSingleMessageTargetAction(actionCtx, params, receiver, nil, target, false, 1000, nil)
			},
		)
		if !result.TargetHandled {
			t.Fatalf("target should have completed before cleanup failure: %#v", result)
		}
		if err == nil || !strings.Contains(err.Error(), "target action completed") || !strings.Contains(err.Error(), "lock lost") {
			t.Fatalf("expected cleanup failure after target completion, got %v", err)
		}
		_, abandoned, _, _ := receiver.snapshot()
		if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1, 2}) {
			t.Fatalf("cleanup attempts = %v, want [1 2]", abandoned)
		}
	})
}

func TestScanActiveSingleMessageCancellationUsesIndependentCleanupContext(t *testing.T) {
	requestCtx, cancel := context.WithCancel(context.Background())
	receiver := &fakeSingleMessageActionReceiver{
		receiveSteps: []fakeSingleReceiveStep{{
			messages: peekTestMessages("active", 1, 2),
			after:    cancel,
		}},
	}
	_, err := scanActiveSingleMessage(
		requestCtx,
		receiver,
		receiver,
		nil,
		99,
		activeSingleMessageScanConfig{ScanBudget: 2, BatchSize: 2, MaxWaitMs: 1000, CleanupConcurrency: 1},
		func(context.Context, *azservicebus.ReceivedMessage) error {
			t.Fatal("unexpected target callback")
			return nil
		},
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	_, abandoned, _, _ := receiver.snapshot()
	if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1, 2}) {
		t.Fatalf("cancellation cleanup = %v, want [1 2]", abandoned)
	}
}

func TestScanActiveSingleMessageRenewsHeldLocksAndCleansUpExpiredLocks(t *testing.T) {
	t.Run("renews regular non-target locks during a slow scan", func(t *testing.T) {
		receiver := &fakeSingleMessageActionReceiver{
			receiveSteps: []fakeSingleReceiveStep{
				{messages: peekTestMessages("active", 1)},
				{messages: peekTestMessages("active", 2), delay: 15 * time.Millisecond},
			},
		}
		params := singleMessageActionParams{Action: "delete", SequenceNumber: 2}
		result, err := scanActiveSingleMessage(
			context.Background(),
			receiver,
			receiver,
			nil,
			2,
			activeSingleMessageScanConfig{
				ScanBudget:          2,
				BatchSize:           1,
				MaxWaitMs:           1000,
				CleanupConcurrency:  1,
				LockRenewalInterval: time.Millisecond,
			},
			func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
				return performSingleMessageTargetAction(actionCtx, params, receiver, nil, target, false, 1000, nil)
			},
		)
		if err != nil || !result.TargetHandled {
			t.Fatalf("slow scan result = %#v, err = %v", result, err)
		}
		_, abandoned, _, renewed := receiver.snapshot()
		if len(renewed) == 0 || renewed[0] != 1 {
			t.Fatalf("renewed locks = %v, want message 1", renewed)
		}
		if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1}) {
			t.Fatalf("abandoned = %v, want [1]", abandoned)
		}
	})

	t.Run("renewal failure before target action releases every received message", func(t *testing.T) {
		receiver := &fakeSingleMessageActionReceiver{
			receiveSteps: []fakeSingleReceiveStep{
				{messages: peekTestMessages("active", 1)},
				{messages: peekTestMessages("active", 2), delay: 15 * time.Millisecond},
			},
			renewErr: map[int64]error{1: errors.New("lock expired")},
		}
		result, err := scanActiveSingleMessage(
			context.Background(),
			receiver,
			receiver,
			nil,
			2,
			activeSingleMessageScanConfig{
				ScanBudget:          2,
				BatchSize:           1,
				MaxWaitMs:           1000,
				CleanupConcurrency:  1,
				LockRenewalInterval: time.Millisecond,
			},
			func(context.Context, *azservicebus.ReceivedMessage) error {
				t.Fatal("target must not be handled after lock renewal fails")
				return nil
			},
		)
		if err == nil || !strings.Contains(err.Error(), "lock expired") {
			t.Fatalf("expected lock-expiry error, got %v", err)
		}
		if result.TargetHandled {
			t.Fatalf("target unexpectedly handled: %#v", result)
		}
		_, abandoned, completed, renewed := receiver.snapshot()
		if len(renewed) == 0 {
			t.Fatal("expected a renewal attempt")
		}
		if fmt.Sprint(abandoned) != fmt.Sprint([]int64{1, 2}) {
			t.Fatalf("expiry cleanup = %v, want [1 2]", abandoned)
		}
		if len(completed) != 0 {
			t.Fatalf("unexpected completed messages: %v", completed)
		}
	})
}

func TestScanActiveSingleMessageRenewsTargetThroughAction(t *testing.T) {
	newExpiringTarget := func() *azservicebus.ReceivedMessage {
		target := peekTestMessages("active", 3)[0]
		lockedUntil := time.Now().Add(5 * time.Millisecond)
		target.LockedUntil = &lockedUntil
		return target
	}
	assertTargetLifecycle := func(t *testing.T, receiver *fakeSingleMessageActionReceiver, result activeSingleMessageScanResult) {
		t.Helper()
		if !result.Found || !result.TargetHandled {
			t.Fatalf("target was not handled: %#v", result)
		}
		_, abandoned, completed, renewed := receiver.snapshot()
		if fmt.Sprint(completed) != fmt.Sprint([]int64{3}) {
			t.Fatalf("completed = %v, want [3]", completed)
		}
		if len(abandoned) != 0 {
			t.Fatalf("target was unexpectedly abandoned: %v", abandoned)
		}
		renewedTarget := false
		for _, sequence := range renewed {
			if sequence == 3 {
				renewedTarget = true
				break
			}
		}
		if !renewedTarget {
			t.Fatalf("target lock was not renewed: %v", renewed)
		}
		time.Sleep(3 * time.Millisecond)
		_, _, _, renewedAfterReturn := receiver.snapshot()
		if len(renewedAfterReturn) != len(renewed) {
			t.Fatalf("target renewal continued after the action returned: before=%v after=%v", renewed, renewedAfterReturn)
		}
	}

	t.Run("slow destination send keeps target locked through source completion", func(t *testing.T) {
		receiver := &fakeSingleMessageActionReceiver{
			receiveSteps:     []fakeSingleReceiveStep{{messages: []*azservicebus.ReceivedMessage{newExpiringTarget()}}},
			requireValidLock: true,
		}
		sender := &fakeSingleMessageSender{delay: 25 * time.Millisecond}
		params := singleMessageActionParams{Action: "move", SequenceNumber: 3}
		result, err := scanActiveSingleMessage(
			context.Background(),
			receiver,
			receiver,
			nil,
			3,
			activeSingleMessageScanConfig{
				ScanBudget:          1,
				BatchSize:           1,
				MaxWaitMs:           1000,
				CleanupConcurrency:  1,
				LockRenewalInterval: time.Millisecond,
			},
			func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
				return performSingleMessageTargetAction(actionCtx, params, receiver, sender, target, false, 1000, nil)
			},
		)
		if err != nil {
			t.Fatalf("slow move failed: %v", err)
		}
		assertTargetLifecycle(t, receiver, result)
		if sender.sent != 1 {
			t.Fatalf("destination sends = %d, want 1", sender.sent)
		}
	})

	t.Run("slow delete keeps target locked through completion", func(t *testing.T) {
		receiver := &fakeSingleMessageActionReceiver{
			receiveSteps:     []fakeSingleReceiveStep{{messages: []*azservicebus.ReceivedMessage{newExpiringTarget()}}},
			completeDelay:    25 * time.Millisecond,
			requireValidLock: true,
		}
		params := singleMessageActionParams{Action: "delete", SequenceNumber: 3}
		result, err := scanActiveSingleMessage(
			context.Background(),
			receiver,
			receiver,
			nil,
			3,
			activeSingleMessageScanConfig{
				ScanBudget:          1,
				BatchSize:           1,
				MaxWaitMs:           1000,
				CleanupConcurrency:  1,
				LockRenewalInterval: time.Millisecond,
			},
			func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
				return performSingleMessageTargetAction(actionCtx, params, receiver, nil, target, false, 1000, nil)
			},
		)
		if err != nil {
			t.Fatalf("slow delete failed: %v", err)
		}
		assertTargetLifecycle(t, receiver, result)
	})
}

func TestScanActiveSingleMessageTargetRenewalFailureCancelsActionAndCleansUpOnce(t *testing.T) {
	sendStarted := make(chan struct{})
	receiver := &fakeSingleMessageActionReceiver{
		receiveSteps: []fakeSingleReceiveStep{{messages: peekTestMessages("active", 1, 3, 2)}},
		renewHook: func(ctx context.Context, sequence int64) error {
			if sequence != 3 {
				return nil
			}
			select {
			case <-sendStarted:
				return errors.New("target lock expired")
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
	sender := &fakeSingleMessageSender{
		delay:   50 * time.Millisecond,
		started: sendStarted,
	}
	params := singleMessageActionParams{Action: "move", SequenceNumber: 3}
	result, err := scanActiveSingleMessage(
		context.Background(),
		receiver,
		receiver,
		nil,
		3,
		activeSingleMessageScanConfig{
			ScanBudget:          3,
			BatchSize:           3,
			MaxWaitMs:           1000,
			CleanupConcurrency:  1,
			LockRenewalInterval: time.Millisecond,
		},
		func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
			return performSingleMessageTargetAction(actionCtx, params, receiver, sender, target, false, 1000, nil)
		},
	)
	if err == nil || !strings.Contains(err.Error(), "renew message 3 lock") || !strings.Contains(err.Error(), "target lock expired") {
		t.Fatalf("expected target renewal failure, got %v", err)
	}
	if !result.Found || result.TargetHandled {
		t.Fatalf("unexpected target result: %#v", result)
	}
	if sender.sent != 0 {
		t.Fatalf("destination accepted %d messages after renewal failure, want 0", sender.sent)
	}
	_, abandoned, completed, renewed := receiver.snapshot()
	if len(completed) != 0 {
		t.Fatalf("source completion must not run after renewal failure: %v", completed)
	}
	abandonCounts := map[int64]int{}
	for _, sequence := range abandoned {
		abandonCounts[sequence]++
	}
	for _, sequence := range []int64{1, 2, 3} {
		if abandonCounts[sequence] != 1 {
			t.Fatalf("abandon counts = %v, want each received message exactly once", abandonCounts)
		}
	}
	renewedTarget := false
	for _, sequence := range renewed {
		if sequence == 3 {
			renewedTarget = true
			break
		}
	}
	if !renewedTarget {
		t.Fatalf("expected the target renewal attempt to fail during the action: %v", renewed)
	}
}

func TestSingleMessageSourceSubQueueSelection(t *testing.T) {
	tests := []struct {
		name string
		p    singleMessageActionParams
		want azservicebus.SubQueue
	}{
		{
			name: "stable active enum",
			p:    singleMessageActionParams{IsDlq: false, SourceSubQueue: "active"},
			want: 0,
		},
		{
			name: "stable dead letter enum",
			p:    singleMessageActionParams{IsDlq: true, SourceSubQueue: "deadLetter"},
			want: azservicebus.SubQueueDeadLetter,
		},
		{
			name: "stable transfer dead letter enum",
			p:    singleMessageActionParams{IsDlq: true, SourceSubQueue: "transferDeadLetter"},
			want: azservicebus.SubQueueTransfer,
		},
		{
			name: "legacy display label fallback",
			p:    singleMessageActionParams{IsDlq: true, Source: "Transfer Dead Letter Queue: q1"},
			want: azservicebus.SubQueueTransfer,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.p.sourceSubQueue(); got != tt.want {
				t.Fatalf("expected %v, got %v", tt.want, got)
			}
		})
	}
}

func TestEntityNameWithSubQueue(t *testing.T) {
	if got := entityNameWithSubQueue("orders", azservicebus.SubQueueDeadLetter); got != "orders/$DeadLetterQueue" {
		t.Fatalf("unexpected dead-letter path: %q", got)
	}
	if got := entityNameWithSubQueue("orders", azservicebus.SubQueueTransfer); got != "orders/$Transfer/$DeadLetterQueue" {
		t.Fatalf("unexpected transfer DLQ path: %q", got)
	}
	if got := entityNameWithSubQueue("orders/$DeadLetterQueue", azservicebus.SubQueueDeadLetter); got != "orders/$DeadLetterQueue" {
		t.Fatalf("should not double-append subqueue path: %q", got)
	}
}

func TestOutboundMessageFromReceivedRegeneratesMessageID(t *testing.T) {
	msgID := "original-message-id"
	seq := int64(42)
	sessionID := "session-a"
	received := &azservicebus.ReceivedMessage{
		MessageID:             msgID,
		SequenceNumber:        &seq,
		SessionID:             &sessionID,
		PartitionKey:          &sessionID,
		ApplicationProperties: map[string]any{"tenant": "blue"},
	}

	out := outboundMessageFromReceived(received, true)
	if out.MessageID == nil {
		t.Fatal("expected regenerated message ID")
	}
	if *out.MessageID == msgID {
		t.Fatal("expected regenerated message ID to differ from original")
	}
	if out.ApplicationProperties["BusmanOriginalMessageId"] != msgID {
		t.Fatalf("expected original message ID metadata, got %#v", out.ApplicationProperties)
	}
	if received.ApplicationProperties["BusmanOriginalMessageId"] != nil {
		t.Fatal("expected source application properties to remain unchanged")
	}
	if out.SessionID == nil || *out.SessionID != sessionID || out.PartitionKey == nil || *out.PartitionKey != sessionID {
		t.Fatalf("session/partition metadata was not preserved: session=%#v partition=%#v", out.SessionID, out.PartitionKey)
	}
}

func TestOutboundMessageFromReceivedDuplicateDetectionPolicy(t *testing.T) {
	t.Run("preserves id when duplicate detection is disabled", func(t *testing.T) {
		received := &azservicebus.ReceivedMessage{
			MessageID:             "original-id",
			ApplicationProperties: map[string]any{"tenant": "blue"},
		}
		out := outboundMessageFromReceived(received, false)
		if out.MessageID == nil || *out.MessageID != "original-id" {
			t.Fatalf("expected original MessageId, got %#v", out.MessageID)
		}
		if _, ok := out.ApplicationProperties["BusmanOriginalMessageId"]; ok {
			t.Fatalf("unexpected trace property: %#v", out.ApplicationProperties)
		}
	})

	t.Run("generates id when source id is empty", func(t *testing.T) {
		out := outboundMessageFromReceived(&azservicebus.ReceivedMessage{}, true)
		if out.MessageID == nil || !strings.HasPrefix(*out.MessageID, "busman-") {
			t.Fatalf("expected generated MessageId, got %#v", out.MessageID)
		}
	})
}

func TestUniqueBusmanMessageIDIsConcurrentAndLengthSafe(t *testing.T) {
	const count = 200
	original := strings.Repeat("x", 128)
	ids := make(map[string]struct{}, count)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := uniqueBusmanMessageID(original)
			if len(id) > 128 {
				t.Errorf("MessageId length = %d, want <= 128", len(id))
			}
			mu.Lock()
			defer mu.Unlock()
			if _, exists := ids[id]; exists {
				t.Errorf("duplicate generated MessageId %q", id)
			}
			ids[id] = struct{}{}
		}()
	}
	wg.Wait()
	if len(ids) != count {
		t.Fatalf("generated %d unique IDs, want %d", len(ids), count)
	}
}

type fakeDuplicateDetectionAdmin struct {
	queueResponse *admin.GetQueueResponse
	topicResponse *admin.GetTopicResponse
	queueErr      error
	topicErr      error
	queueNames    []string
	topicNames    []string
}

func (f *fakeDuplicateDetectionAdmin) GetQueue(_ context.Context, name string, _ *admin.GetQueueOptions) (*admin.GetQueueResponse, error) {
	f.queueNames = append(f.queueNames, name)
	return f.queueResponse, f.queueErr
}

func (f *fakeDuplicateDetectionAdmin) GetTopic(_ context.Context, name string, _ *admin.GetTopicOptions) (*admin.GetTopicResponse, error) {
	f.topicNames = append(f.topicNames, name)
	return f.topicResponse, f.topicErr
}

func TestDestinationPolicyRoutesByEntityKind(t *testing.T) {
	enabled := true
	disabled := false

	t.Run("queue destination", func(t *testing.T) {
		client := &fakeDuplicateDetectionAdmin{
			queueResponse: &admin.GetQueueResponse{
				QueueName: "archive",
				QueueProperties: admin.QueueProperties{
					RequiresDuplicateDetection: &enabled,
					EnablePartitioning:         &enabled,
					RequiresSession:            &enabled,
				},
			},
		}
		got, err := destinationPolicy(
			context.Background(),
			client,
			messageDestination{Name: "archive", Kind: messageDestinationQueue},
		)
		if err != nil {
			t.Fatalf("inspection returned error: %v", err)
		}
		if !got.RequiresDuplicateDetection || !got.EnablePartitioning || !got.RequiresSession {
			t.Fatalf("unexpected queue policy: %#v", got)
		}
		if len(client.queueNames) != 1 || client.queueNames[0] != "archive" || len(client.topicNames) != 0 {
			t.Fatalf("unexpected admin calls: queues=%v topics=%v", client.queueNames, client.topicNames)
		}
	})

	t.Run("topic destination", func(t *testing.T) {
		client := &fakeDuplicateDetectionAdmin{
			topicResponse: &admin.GetTopicResponse{
				TopicName: "events",
				TopicProperties: admin.TopicProperties{
					RequiresDuplicateDetection: &enabled,
					EnablePartitioning:         &enabled,
				},
			},
		}
		got, err := destinationPolicy(
			context.Background(),
			client,
			messageDestination{Name: "events", Kind: messageDestinationTopic},
		)
		if err != nil {
			t.Fatalf("inspection returned error: %v", err)
		}
		if !got.RequiresDuplicateDetection || !got.EnablePartitioning || got.RequiresSession {
			t.Fatalf("unexpected topic policy: %#v", got)
		}
		if len(client.topicNames) != 1 || client.topicNames[0] != "events" || len(client.queueNames) != 0 {
			t.Fatalf("unexpected admin calls: queues=%v topics=%v", client.queueNames, client.topicNames)
		}
	})

	t.Run("disabled policy preserves ids", func(t *testing.T) {
		client := &fakeDuplicateDetectionAdmin{
			queueResponse: &admin.GetQueueResponse{
				QueueName: "plain",
				QueueProperties: admin.QueueProperties{
					RequiresDuplicateDetection: &disabled,
				},
			},
		}
		got, err := destinationPolicy(
			context.Background(),
			client,
			messageDestination{Name: "plain", Kind: messageDestinationQueue},
		)
		if err != nil {
			t.Fatalf("inspection returned error: %v", err)
		}
		if got != (destinationSendPolicy{}) {
			t.Fatalf("expected disabled policy, got %#v", got)
		}
	})

	t.Run("inspection error is returned", func(t *testing.T) {
		client := &fakeDuplicateDetectionAdmin{queueErr: errors.New("management denied")}
		_, err := destinationPolicy(
			context.Background(),
			client,
			messageDestination{Name: "archive", Kind: messageDestinationQueue},
		)
		if err == nil || !strings.Contains(err.Error(), "management denied") {
			t.Fatalf("expected inspection failure, got %v", err)
		}
		if len(client.queueNames) != 1 {
			t.Fatalf("queue inspection count = %d, want 1", len(client.queueNames))
		}
	})

	t.Run("missing destination is returned as error", func(t *testing.T) {
		client := &fakeDuplicateDetectionAdmin{}
		_, err := destinationPolicy(
			context.Background(),
			client,
			messageDestination{Name: "missing", Kind: messageDestinationTopic},
		)
		if err == nil || !strings.Contains(err.Error(), "was not found") {
			t.Fatalf("expected missing destination error, got %v", err)
		}
	})
}

type fakeOutboundBatch struct {
	capacity int
	messages []*azservicebus.Message
}

func (b *fakeOutboundBatch) AddMessage(msg *azservicebus.Message, _ *azservicebus.AddMessageOptions) error {
	if len(b.messages) >= b.capacity {
		return azservicebus.ErrMessageTooLarge
	}
	b.messages = append(b.messages, msg)
	return nil
}

func (b *fakeOutboundBatch) NumMessages() int32 {
	return int32(len(b.messages))
}

func receivedForBatch(id string, partitionKey, sessionID *string) *azservicebus.ReceivedMessage {
	return &azservicebus.ReceivedMessage{
		MessageID:    id,
		PartitionKey: partitionKey,
		SessionID:    sessionID,
	}
}

func sourceMessageIDs(messages []*azservicebus.ReceivedMessage) []string {
	ids := make([]string, len(messages))
	for i, msg := range messages {
		ids[i] = msg.MessageID
	}
	return ids
}

func TestSendMessagesInCompatibleBatchesAffinity(t *testing.T) {
	partitionA := "partition-a"
	partitionB := "partition-b"
	sessionA := "session-a"
	sessionB := "session-b"
	blankSession := ""

	tests := []struct {
		name     string
		policy   destinationSendPolicy
		messages []*azservicebus.ReceivedMessage
		want     [][]string
	}{
		{
			name:   "unpartitioned destination keeps mixed partition keys together",
			policy: destinationSendPolicy{},
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("one", &partitionA, nil),
				receivedForBatch("two", &partitionB, nil),
				receivedForBatch("three", nil, nil),
			},
			want: [][]string{{"one", "two", "three"}},
		},
		{
			name:   "partitioned destination flushes when partition key changes",
			policy: destinationSendPolicy{EnablePartitioning: true},
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("a1", &partitionA, nil),
				receivedForBatch("a2", &partitionA, nil),
				receivedForBatch("b1", &partitionB, nil),
				receivedForBatch("none1", nil, nil),
				receivedForBatch("none2", nil, nil),
				receivedForBatch("a3", &partitionA, nil),
			},
			want: [][]string{{"a1", "a2"}, {"b1"}, {"none1", "none2"}, {"a3"}},
		},
		{
			name: "duplicate-detection message ids are effective partition affinity",
			policy: destinationSendPolicy{
				EnablePartitioning:         true,
				RequiresDuplicateDetection: true,
			},
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("one", nil, nil),
				receivedForBatch("two", nil, nil),
				receivedForBatch("three", nil, nil),
			},
			want: [][]string{{"one"}, {"two"}, {"three"}},
		},
		{
			name: "explicit partition key overrides duplicate-detection message id affinity",
			policy: destinationSendPolicy{
				EnablePartitioning:         true,
				RequiresDuplicateDetection: true,
			},
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("one", &partitionA, nil),
				receivedForBatch("two", &partitionA, nil),
			},
			want: [][]string{{"one", "two"}},
		},
		{
			name:   "session affinity flushes on mixed and missing session ids",
			policy: destinationSendPolicy{},
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("s-a1", nil, &sessionA),
				receivedForBatch("s-a2", &sessionA, &sessionA),
				receivedForBatch("missing1", &partitionA, nil),
				receivedForBatch("missing2", &partitionB, nil),
				receivedForBatch("s-b", nil, &sessionB),
			},
			want: [][]string{{"s-a1", "s-a2"}, {"missing1", "missing2"}, {"s-b"}},
		},
		{
			name:   "blank session id remains distinct from missing session id",
			policy: destinationSendPolicy{},
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("blank1", nil, &blankSession),
				receivedForBatch("blank2", &blankSession, &blankSession),
				receivedForBatch("missing", nil, nil),
			},
			want: [][]string{{"blank1", "blank2"}, {"missing"}},
		},
		{
			name:   "one session receiver run remains one batch",
			policy: destinationSendPolicy{EnablePartitioning: true, RequiresSession: true},
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("first", nil, &sessionA),
				receivedForBatch("second", &sessionA, &sessionA),
				receivedForBatch("third", nil, &sessionA),
			},
			want: [][]string{{"first", "second", "third"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var sent [][]string
			confirmed, err := sendMessagesInCompatibleBatches(
				tt.messages,
				tt.policy,
				func() (*fakeOutboundBatch, error) {
					return &fakeOutboundBatch{capacity: 100}, nil
				},
				func(_ *fakeOutboundBatch, sources []*azservicebus.ReceivedMessage) (int, error) {
					sent = append(sent, sourceMessageIDs(sources))
					return len(sources), nil
				},
			)
			if err != nil {
				t.Fatalf("sendMessagesInCompatibleBatches returned error: %v", err)
			}
			if confirmed != len(tt.messages) {
				t.Fatalf("confirmed = %d, want %d", confirmed, len(tt.messages))
			}
			if fmt.Sprint(sent) != fmt.Sprint(tt.want) {
				t.Fatalf("sent batches = %v, want %v", sent, tt.want)
			}
		})
	}
}

func TestSendMessagesInCompatibleBatchesRejectsInvalidSessionMetadataBeforeSending(t *testing.T) {
	partitionA := "partition-a"
	sessionA := "session-a"

	tests := []struct {
		name     string
		messages []*azservicebus.ReceivedMessage
		wantErr  string
	}{
		{
			name: "missing session id",
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("valid", nil, &sessionA),
				receivedForBatch("missing", nil, nil),
			},
			wantErr: "destination requires sessions",
		},
		{
			name: "partition and session mismatch",
			messages: []*azservicebus.ReceivedMessage{
				receivedForBatch("mismatch", &partitionA, &sessionA),
			},
			wantErr: "incompatible PartitionKey",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			newBatchCalls := 0
			sendCalls := 0
			confirmed, err := sendMessagesInCompatibleBatches(
				tt.messages,
				destinationSendPolicy{RequiresSession: true},
				func() (*fakeOutboundBatch, error) {
					newBatchCalls++
					return &fakeOutboundBatch{capacity: 100}, nil
				},
				func(_ *fakeOutboundBatch, sources []*azservicebus.ReceivedMessage) (int, error) {
					sendCalls++
					return len(sources), nil
				},
			)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("expected %q error, got %v", tt.wantErr, err)
			}
			if confirmed != 0 || newBatchCalls != 0 || sendCalls != 0 {
				t.Fatalf("invalid metadata performed work: confirmed=%d newBatch=%d send=%d", confirmed, newBatchCalls, sendCalls)
			}
		})
	}
}

func TestSendMessagesInCompatibleBatchesFlushesAtCapacity(t *testing.T) {
	partitionA := "partition-a"
	messages := []*azservicebus.ReceivedMessage{
		receivedForBatch("one", &partitionA, nil),
		receivedForBatch("two", &partitionA, nil),
		receivedForBatch("three", &partitionA, nil),
		receivedForBatch("four", &partitionA, nil),
		receivedForBatch("five", &partitionA, nil),
	}
	var sent [][]string
	confirmed, err := sendMessagesInCompatibleBatches(
		messages,
		destinationSendPolicy{EnablePartitioning: true},
		func() (*fakeOutboundBatch, error) {
			return &fakeOutboundBatch{capacity: 2}, nil
		},
		func(_ *fakeOutboundBatch, sources []*azservicebus.ReceivedMessage) (int, error) {
			sent = append(sent, sourceMessageIDs(sources))
			return len(sources), nil
		},
	)
	if err != nil {
		t.Fatalf("sendMessagesInCompatibleBatches returned error: %v", err)
	}
	if confirmed != 5 {
		t.Fatalf("confirmed = %d, want 5", confirmed)
	}
	want := [][]string{{"one", "two"}, {"three", "four"}, {"five"}}
	if fmt.Sprint(sent) != fmt.Sprint(want) {
		t.Fatalf("sent batches = %v, want %v", sent, want)
	}
}

func TestSendMessagesInCompatibleBatchesStopsAtFailureBoundary(t *testing.T) {
	partitionA := "partition-a"
	partitionB := "partition-b"
	partitionC := "partition-c"
	messages := []*azservicebus.ReceivedMessage{
		receivedForBatch("a1", &partitionA, nil),
		receivedForBatch("a2", &partitionA, nil),
		receivedForBatch("b1", &partitionB, nil),
		receivedForBatch("b2", &partitionB, nil),
		receivedForBatch("c1", &partitionC, nil),
	}

	t.Run("send failure completes no messages from failed batch", func(t *testing.T) {
		var attempted [][]string
		var completed []string
		confirmed, err := sendMessagesInCompatibleBatches(
			messages,
			destinationSendPolicy{EnablePartitioning: true},
			func() (*fakeOutboundBatch, error) { return &fakeOutboundBatch{capacity: 100}, nil },
			func(_ *fakeOutboundBatch, sources []*azservicebus.ReceivedMessage) (int, error) {
				ids := sourceMessageIDs(sources)
				attempted = append(attempted, ids)
				if len(attempted) == 2 {
					return 0, errors.New("send failed")
				}
				completed = append(completed, ids...)
				return len(sources), nil
			},
		)
		if err == nil || !strings.Contains(err.Error(), "send failed") {
			t.Fatalf("expected send failure, got %v", err)
		}
		if confirmed != 2 || fmt.Sprint(completed) != fmt.Sprint([]string{"a1", "a2"}) {
			t.Fatalf("unexpected completion boundary: confirmed=%d completed=%v", confirmed, completed)
		}
		wantAttempts := [][]string{{"a1", "a2"}, {"b1", "b2"}}
		if fmt.Sprint(attempted) != fmt.Sprint(wantAttempts) {
			t.Fatalf("attempted batches = %v, want %v", attempted, wantAttempts)
		}
	})

	t.Run("partial settlement failure reports only confirmed sources", func(t *testing.T) {
		var attempted [][]string
		confirmed, err := sendMessagesInCompatibleBatches(
			messages,
			destinationSendPolicy{EnablePartitioning: true},
			func() (*fakeOutboundBatch, error) { return &fakeOutboundBatch{capacity: 100}, nil },
			func(_ *fakeOutboundBatch, sources []*azservicebus.ReceivedMessage) (int, error) {
				attempted = append(attempted, sourceMessageIDs(sources))
				if len(attempted) == 2 {
					return 1, errors.New("settlement failed")
				}
				return len(sources), nil
			},
		)
		if err == nil || !strings.Contains(err.Error(), "settlement failed") {
			t.Fatalf("expected settlement failure, got %v", err)
		}
		if confirmed != 3 {
			t.Fatalf("confirmed = %d, want 3", confirmed)
		}
		if len(attempted) != 2 {
			t.Fatalf("attempted %d batches, want 2", len(attempted))
		}
	})
}

func TestValidateSingleMessageTargetGuardsMessageIdentity(t *testing.T) {
	seq := int64(42)
	sessionID := "session-a"
	msg := &azservicebus.ReceivedMessage{
		MessageID:      "msg-42",
		SequenceNumber: &seq,
		SessionID:      &sessionID,
	}

	if err := validateSingleMessageTarget(singleMessageActionParams{
		SequenceNumber: 42,
		MessageID:      "msg-42",
		SessionID:      &sessionID,
	}, msg, "test"); err != nil {
		t.Fatalf("expected target to validate, got %v", err)
	}
	if err := validateSingleMessageTarget(singleMessageActionParams{
		SequenceNumber: 42,
		MessageID:      "other",
	}, msg, "test"); err == nil || !strings.Contains(err.Error(), "expected") {
		t.Fatalf("expected messageId mismatch error, got %v", err)
	}
}

func TestValidateRuleName(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{name: "allows default rule", value: "$Default", wantErr: false},
		{name: "allows separators", value: "invoice.high-priority", wantErr: false},
		{name: "rejects empty", value: "", wantErr: true},
		{name: "rejects spaces", value: "bad rule", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateRuleName(tt.value)
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}

func TestMapRuleProperties(t *testing.T) {
	subject := "invoice.created"
	tests := []struct {
		name     string
		rule     admin.RuleProperties
		wantKind string
	}{
		{
			name: "maps sql filter and action",
			rule: admin.RuleProperties{
				Name: "sql-rule",
				Filter: &admin.SQLFilter{
					Expression: "sys.Label = @label",
					Parameters: map[string]any{"label": "blue", "retries": 2},
				},
				Action: &admin.SQLAction{
					Expression: "SET priority = 'high'",
					Parameters: map[string]any{"enabled": true},
				},
			},
			wantKind: "sql",
		},
		{
			name: "maps correlation filter",
			rule: admin.RuleProperties{
				Name: "corr-rule",
				Filter: &admin.CorrelationFilter{
					Subject:               &subject,
					ApplicationProperties: map[string]any{"tenant": "blue"},
				},
			},
			wantKind: "correlation",
		},
		{
			name: "maps true filter",
			rule: admin.RuleProperties{
				Name:   "$Default",
				Filter: &admin.TrueFilter{},
			},
			wantKind: "true",
		},
		{
			name: "maps false filter",
			rule: admin.RuleProperties{
				Name:   "reject-all",
				Filter: &admin.FalseFilter{},
			},
			wantKind: "false",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mapped, err := mapRuleProperties(tt.rule)
			if err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
			filter, ok := mapped["filter"].(map[string]any)
			if !ok {
				t.Fatalf("expected filter map, got %#v", mapped["filter"])
			}
			if filter["kind"] != tt.wantKind {
				t.Fatalf("expected filter kind %q, got %#v", tt.wantKind, filter["kind"])
			}
		})
	}
}

func TestBuildRuleProperties(t *testing.T) {
	rule, err := buildRuleProperties(subscriptionRulePayload{
		Name: "tenant-filter",
		Filter: subscriptionRuleFilterPayload{
			Kind:          "correlation",
			CorrelationID: strPtr("tenant-a"),
			Subject:       strPtr("invoice.updated"),
			ApplicationProperties: map[string]any{
				"tenant":  "blue",
				"attempt": 2,
			},
		},
		Action: &subscriptionRuleActionPayload{
			Expression: "SET priority = 'high'",
			Parameters: map[string]any{"enabled": true},
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	filter, ok := rule.Filter.(*admin.CorrelationFilter)
	if !ok {
		t.Fatalf("expected correlation filter, got %T", rule.Filter)
	}
	if filter.Subject == nil || *filter.Subject != "invoice.updated" {
		t.Fatalf("expected subject to be invoice.updated, got %#v", filter.Subject)
	}
	action, ok := rule.Action.(*admin.SQLAction)
	if !ok {
		t.Fatalf("expected SQL action, got %T", rule.Action)
	}
	if action.Parameters["enabled"] != true {
		t.Fatalf("expected action parameter to round-trip, got %#v", action.Parameters["enabled"])
	}
}

func TestBuildRulePropertiesRejectsNestedJSON(t *testing.T) {
	_, err := buildRuleProperties(subscriptionRulePayload{
		Name: "bad-rule",
		Filter: subscriptionRuleFilterPayload{
			Kind:       "sql",
			Expression: "1 = 1",
			Parameters: map[string]any{
				"nested": map[string]any{"no": "thanks"},
			},
		},
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

type fakeManagedSessionReceiver struct {
	sessionID   string
	lockedUntil time.Time
	renewErr    error
	renewed     chan struct{}

	mu                sync.Mutex
	closeCalls        int
	completedSequence []int64
}

func (f *fakeManagedSessionReceiver) ReceiveMessages(context.Context, int, *azservicebus.ReceiveMessagesOptions) ([]*azservicebus.ReceivedMessage, error) {
	return nil, nil
}

func (f *fakeManagedSessionReceiver) CompleteMessage(_ context.Context, msg *azservicebus.ReceivedMessage, _ *azservicebus.CompleteMessageOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if msg.SequenceNumber != nil {
		f.completedSequence = append(f.completedSequence, *msg.SequenceNumber)
	}
	return nil
}

func (f *fakeManagedSessionReceiver) Close(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeCalls++
	return nil
}

func (f *fakeManagedSessionReceiver) SessionID() string {
	return f.sessionID
}

func (f *fakeManagedSessionReceiver) LockedUntil() time.Time {
	return f.lockedUntil
}

func (f *fakeManagedSessionReceiver) RenewSessionLock(context.Context, *azservicebus.RenewSessionLockOptions) error {
	if f.renewed != nil {
		select {
		case f.renewed <- struct{}{}:
		default:
		}
	}
	return f.renewErr
}

func TestSessionReceiverEntityNames(t *testing.T) {
	tests := []struct {
		name             string
		queueName        string
		source           subscriptionSource
		subQueue         azservicebus.SubQueue
		wantQueue        string
		wantTopic        string
		wantSubscription string
	}{
		{
			name:      "queue active",
			queueName: "orders",
			wantQueue: "orders",
		},
		{
			name:      "queue dead letter",
			queueName: "orders",
			subQueue:  azservicebus.SubQueueDeadLetter,
			wantQueue: "orders/$DeadLetterQueue",
		},
		{
			name:             "subscription active",
			source:           subscriptionSource{TopicName: "events", SubscriptionName: "processor"},
			wantTopic:        "events",
			wantSubscription: "processor",
		},
		{
			name:             "subscription dead letter",
			source:           subscriptionSource{TopicName: "events", SubscriptionName: "processor"},
			subQueue:         azservicebus.SubQueueDeadLetter,
			wantTopic:        "events",
			wantSubscription: "processor/$DeadLetterQueue",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			queueName, topicName, subscriptionName := sessionReceiverEntityNames(tt.queueName, tt.source, tt.subQueue)
			if queueName != tt.wantQueue || topicName != tt.wantTopic || subscriptionName != tt.wantSubscription {
				t.Fatalf(
					"got queue=%q topic=%q subscription=%q, want queue=%q topic=%q subscription=%q",
					queueName,
					topicName,
					subscriptionName,
					tt.wantQueue,
					tt.wantTopic,
					tt.wantSubscription,
				)
			}
		})
	}
}

func TestSessionLockRenewIntervalUsesSafeBounds(t *testing.T) {
	now := time.Date(2026, time.August, 10, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		lockedUntil time.Time
		want        time.Duration
	}{
		{name: "missing lock metadata", want: time.Second},
		{name: "long lock", lockedUntil: now.Add(time.Minute), want: 20 * time.Second},
		{name: "short lock", lockedUntil: now.Add(10 * time.Second), want: 5 * time.Second},
		{name: "nearly expired lock", lockedUntil: now.Add(100 * time.Millisecond), want: 100 * time.Millisecond},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sessionLockRenewInterval(now, tt.lockedUntil); got != tt.want {
				t.Fatalf("interval = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestConsumeAvailableSessionsVisitsEachSessionAndStopsOnTimeout(t *testing.T) {
	first := &fakeManagedSessionReceiver{sessionID: "alpha", lockedUntil: time.Now().Add(time.Minute)}
	second := &fakeManagedSessionReceiver{sessionID: "beta", lockedUntil: time.Now().Add(time.Minute)}
	receivers := []managedSessionReceiver{first, second}
	acceptCalls := 0

	total, err := consumeAvailableSessions(
		context.Background(),
		1000,
		1000,
		"session queue",
		func(context.Context) (managedSessionReceiver, error) {
			acceptCalls++
			if len(receivers) == 0 {
				return nil, &azservicebus.Error{Code: azservicebus.CodeTimeout}
			}
			receiver := receivers[0]
			receivers = receivers[1:]
			return receiver, nil
		},
		func(receiver managedSessionReceiver, label string) (int, error) {
			switch receiver.SessionID() {
			case "alpha":
				if !strings.Contains(label, `session "alpha"`) {
					t.Fatalf("label does not identify alpha session: %q", label)
				}
				return 2, nil
			case "beta":
				if !strings.Contains(label, `session "beta"`) {
					t.Fatalf("label does not identify beta session: %q", label)
				}
				return 3, nil
			default:
				return 0, errors.New("unexpected session")
			}
		},
	)
	if err != nil {
		t.Fatalf("consumeAvailableSessions returned error: %v", err)
	}
	if total != 5 {
		t.Fatalf("total = %d, want 5", total)
	}
	if acceptCalls != 3 {
		t.Fatalf("accept calls = %d, want 3", acceptCalls)
	}
	if first.closeCalls != 1 || second.closeCalls != 1 {
		t.Fatalf("session receivers were not closed exactly once: alpha=%d beta=%d", first.closeCalls, second.closeCalls)
	}
}

func TestConsumeAvailableSessionsStopsOnRepeatedEmptySession(t *testing.T) {
	acceptCalls := 0
	_, err := consumeAvailableSessions(
		context.Background(),
		1000,
		1000,
		"session subscription DLQ",
		func(context.Context) (managedSessionReceiver, error) {
			acceptCalls++
			return &fakeManagedSessionReceiver{sessionID: "state-only", lockedUntil: time.Now().Add(time.Minute)}, nil
		},
		func(managedSessionReceiver, string) (int, error) { return 0, nil },
	)
	if err == nil || !strings.Contains(err.Error(), "accepted repeatedly without receivable messages") {
		t.Fatalf("expected repeated empty-session error, got %v", err)
	}
	if acceptCalls != 2 {
		t.Fatalf("accept calls = %d, want 2", acceptCalls)
	}
}

func TestSessionLockRenewerRenewsAndSurfacesFailure(t *testing.T) {
	t.Run("renews until stopped", func(t *testing.T) {
		receiver := &fakeManagedSessionReceiver{
			sessionID: "alpha",
			renewed:   make(chan struct{}, 1),
		}
		renewer := startSessionLockRenewer(context.Background(), receiver, 1000, time.Millisecond)
		select {
		case <-receiver.renewed:
		case <-time.After(time.Second):
			t.Fatal("session lock was not renewed")
		}
		if err := renewer.stop(); err != nil {
			t.Fatalf("stop returned error: %v", err)
		}
	})

	t.Run("reports renewal failure", func(t *testing.T) {
		receiver := &fakeManagedSessionReceiver{
			sessionID: "beta",
			renewErr:  errors.New("lock lost"),
		}
		renewer := startSessionLockRenewer(context.Background(), receiver, 1000, time.Millisecond)
		select {
		case <-renewer.done:
		case <-time.After(time.Second):
			t.Fatal("session lock renewal failure was not reported")
		}
		err := renewer.stop()
		if err == nil || !strings.Contains(err.Error(), `renew session "beta" lock`) {
			t.Fatalf("unexpected renewal error: %v", err)
		}
	})
}

func TestCompleteReceivedMessagesPreservesOrderWhenSequential(t *testing.T) {
	receiver := &fakeManagedSessionReceiver{}
	sequenceNumbers := []int64{10, 11, 12}
	messages := make([]*azservicebus.ReceivedMessage, 0, len(sequenceNumbers))
	for i := range sequenceNumbers {
		sequenceNumber := sequenceNumbers[i]
		messages = append(messages, &azservicebus.ReceivedMessage{SequenceNumber: &sequenceNumber})
	}

	completed, err := completeReceivedMessages(context.Background(), receiver, messages, nil, 1000, 1)
	if err != nil {
		t.Fatalf("completeReceivedMessages returned error: %v", err)
	}
	if completed != len(messages) {
		t.Fatalf("completed = %d, want %d", completed, len(messages))
	}
	if len(receiver.completedSequence) != len(sequenceNumbers) {
		t.Fatalf("completed sequence count = %d, want %d", len(receiver.completedSequence), len(sequenceNumbers))
	}
	for i, sequenceNumber := range sequenceNumbers {
		if receiver.completedSequence[i] != sequenceNumber {
			t.Fatalf("completed sequence[%d] = %d, want %d", i, receiver.completedSequence[i], sequenceNumber)
		}
	}
}

func strPtr(value string) *string {
	return &value
}
