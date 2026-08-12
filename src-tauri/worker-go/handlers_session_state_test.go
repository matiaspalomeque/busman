package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

type fakeQueueSessionAdmin struct {
	response *admin.GetQueueResponse
	err      error
	calls    []string
}

func (f *fakeQueueSessionAdmin) GetQueue(_ context.Context, name string, _ *admin.GetQueueOptions) (*admin.GetQueueResponse, error) {
	f.calls = append(f.calls, name)
	return f.response, f.err
}

func TestValidateSendSessionRequirement(t *testing.T) {
	requiresSession := true
	client := &fakeQueueSessionAdmin{response: &admin.GetQueueResponse{
		QueueName: "orders",
		QueueProperties: admin.QueueProperties{
			RequiresSession: &requiresSession,
		},
	}}

	if err := validateSendSessionRequirement(context.Background(), client, "queue", "orders", ""); err == nil || !strings.Contains(err.Error(), "requires sessions") {
		t.Fatalf("expected blank Session Id validation error, got %v", err)
	}
	if err := validateSendSessionRequirement(context.Background(), client, "queue", "orders", "session-42"); err != nil {
		t.Fatalf("valid session send was rejected: %v", err)
	}
	if err := validateSendSessionRequirement(context.Background(), nil, "topic", "events", ""); err != nil {
		t.Fatalf("topic send must not infer subscription session requirements: %v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("queue property calls = %v, want exactly two queue validations", client.calls)
	}

	client.err = errors.New("management denied")
	if err := validateSendSessionRequirement(context.Background(), client, "queue", "orders", "session-42"); err == nil || !strings.Contains(err.Error(), "management denied") {
		t.Fatalf("expected management error, got %v", err)
	}
	if err := validateSendSessionRequirement(context.Background(), client, "subscription", "orders", "session-42"); err == nil {
		t.Fatal("expected invalid entity kind error")
	}
}

type fakeSessionStateReceiver struct {
	mu sync.Mutex

	sessionID   string
	lockedUntil time.Time
	state       []byte
	getDelay    time.Duration
	setDelay    time.Duration
	renewErr    error
	renewals    int
	closes      int
	setCalls    int
	lastSetNil  bool
}

func (f *fakeSessionStateReceiver) SessionID() string {
	return f.sessionID
}

func (f *fakeSessionStateReceiver) LockedUntil() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lockedUntil
}

func (f *fakeSessionStateReceiver) RenewSessionLock(ctx context.Context, _ *azservicebus.RenewSessionLockOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renewals++
	if f.renewErr != nil {
		return f.renewErr
	}
	f.lockedUntil = time.Now().Add(time.Minute)
	return nil
}

func waitSessionStateDelay(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (f *fakeSessionStateReceiver) GetSessionState(ctx context.Context, _ *azservicebus.GetSessionStateOptions) ([]byte, error) {
	f.mu.Lock()
	delay := f.getDelay
	f.mu.Unlock()
	if delay > 0 {
		if err := waitSessionStateDelay(ctx, delay); err != nil {
			return nil, err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state == nil {
		return nil, nil
	}
	return append([]byte(nil), f.state...), nil
}

func (f *fakeSessionStateReceiver) SetSessionState(ctx context.Context, state []byte, _ *azservicebus.SetSessionStateOptions) error {
	f.mu.Lock()
	delay := f.setDelay
	f.mu.Unlock()
	if delay > 0 {
		if err := waitSessionStateDelay(ctx, delay); err != nil {
			return err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setCalls++
	f.lastSetNil = state == nil
	if state == nil {
		f.state = nil
	} else {
		f.state = append([]byte(nil), state...)
	}
	return nil
}

func (f *fakeSessionStateReceiver) Close(context.Context) error {
	f.mu.Lock()
	f.closes++
	f.mu.Unlock()
	return nil
}

func (f *fakeSessionStateReceiver) snapshot() (state []byte, renewals int, closes int, setCalls int, lastSetNil bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.state...), f.renewals, f.closes, f.setCalls, f.lastSetNil
}

func newFakeSessionStateReceiver(state []byte) *fakeSessionStateReceiver {
	return &fakeSessionStateReceiver{
		sessionID:   "session-42",
		lockedUntil: time.Now().Add(time.Minute),
		state:       append([]byte(nil), state...),
	}
}

func TestSessionStateParamsValidateKnownParentEntityAndAction(t *testing.T) {
	state := "AA=="
	valid := []sessionStateParams{
		{Action: "get", QueueName: "orders", SessionID: "session-42"},
		{Action: "get", subscriptionSource: subscriptionSource{TopicName: "events", SubscriptionName: "processor"}, SessionID: "session-42"},
		{Action: "set", QueueName: "orders", SessionID: "session-42", StateBase64: &state},
		{Action: "clear", QueueName: "orders", SessionID: "session-42"},
	}
	for _, params := range valid {
		if err := params.validate(); err != nil {
			t.Errorf("valid params %#v rejected: %v", params, err)
		}
	}

	invalid := []sessionStateParams{
		{Action: "get", SessionID: "session-42"},
		{Action: "get", QueueName: "orders", subscriptionSource: subscriptionSource{TopicName: "events", SubscriptionName: "processor"}, SessionID: "session-42"},
		{Action: "get", subscriptionSource: subscriptionSource{TopicName: "events"}, SessionID: "session-42"},
		{Action: "get", QueueName: "orders", SessionID: " "},
		{Action: "set", QueueName: "orders", SessionID: "session-42"},
		{Action: "clear", QueueName: "orders", SessionID: "session-42", StateBase64: &state},
		{Action: "enumerate", QueueName: "orders", SessionID: "session-42"},
	}
	for _, params := range invalid {
		if err := params.validate(); err == nil {
			t.Errorf("invalid params %#v were accepted", params)
		}
	}
}

func TestSessionStateBase64PolicyIsCanonicalLosslessAndBounded(t *testing.T) {
	original := []byte{0x00, 0xff, 0x80, 0x41}
	encoded := base64.StdEncoding.EncodeToString(original)
	decoded, err := decodeSessionStateBase64(encoded)
	if err != nil {
		t.Fatalf("decode canonical base64: %v", err)
	}
	if !bytes.Equal(decoded, original) {
		t.Fatalf("decoded bytes = %v, want %v", decoded, original)
	}
	for _, value := range []string{"_w==", "A===", "AA", " AA==", "AA==\n"} {
		if _, err := decodeSessionStateBase64(value); err == nil {
			t.Errorf("invalid base64 %q was accepted", value)
		}
	}
	tooLarge := strings.Repeat("A", base64.StdEncoding.EncodedLen(maxSessionStateBytes)+4)
	if _, err := decodeSessionStateBase64(tooLarge); err == nil || !strings.Contains(err.Error(), "payload limit") {
		t.Fatalf("expected payload-limit error, got %v", err)
	}
	if _, err := encodeSessionStateResult(make([]byte, maxSessionStateBytes+1), true); err == nil || !strings.Contains(err.Error(), "response policy") {
		t.Fatalf("expected response-policy error, got %v", err)
	}
}

func TestRunSessionStateActionGetSetAndClear(t *testing.T) {
	t.Run("get returns explicit lossless base64", func(t *testing.T) {
		state := []byte{0x00, 0xff, 0x80}
		receiver := newFakeSessionStateReceiver(state)
		result, err := runSessionStateAction(context.Background(), receiver, sessionStateParams{Action: "get", SessionID: "session-42"}, 1000)
		if err != nil {
			t.Fatalf("get state: %v", err)
		}
		if result.Encoding != "base64" || result.StateBase64 != base64.StdEncoding.EncodeToString(state) || result.ByteLength != len(state) || !result.HasState {
			t.Fatalf("unexpected get result: %#v", result)
		}
		_, _, closes, _, _ := receiver.snapshot()
		if closes != 1 {
			t.Fatalf("receiver closes = %d, want 1", closes)
		}
	})

	t.Run("set replaces bytes without text coercion", func(t *testing.T) {
		encoded := base64.StdEncoding.EncodeToString([]byte{0xff, 0x00, 0x41})
		receiver := newFakeSessionStateReceiver([]byte("old"))
		result, err := runSessionStateAction(context.Background(), receiver, sessionStateParams{Action: "set", SessionID: "session-42", StateBase64: &encoded}, 1000)
		if err != nil {
			t.Fatalf("set state: %v", err)
		}
		state, _, closes, setCalls, lastSetNil := receiver.snapshot()
		if !bytes.Equal(state, []byte{0xff, 0x00, 0x41}) || setCalls != 1 || lastSetNil || closes != 1 || !result.HasState {
			t.Fatalf("unexpected set lifecycle: state=%v result=%#v calls=%d nil=%v closes=%d", state, result, setCalls, lastSetNil, closes)
		}
	})

	t.Run("clear passes nil state explicitly", func(t *testing.T) {
		receiver := newFakeSessionStateReceiver([]byte("old"))
		result, err := runSessionStateAction(context.Background(), receiver, sessionStateParams{Action: "clear", SessionID: "session-42"}, 1000)
		if err != nil {
			t.Fatalf("clear state: %v", err)
		}
		state, _, closes, setCalls, lastSetNil := receiver.snapshot()
		if state != nil || setCalls != 1 || !lastSetNil || closes != 1 || result.HasState || result.StateBase64 != "" {
			t.Fatalf("unexpected clear lifecycle: state=%v result=%#v calls=%d nil=%v closes=%d", state, result, setCalls, lastSetNil, closes)
		}
	})
}

func TestRunSessionStateActionRenewsAndCleansSessionLock(t *testing.T) {
	receiver := newFakeSessionStateReceiver([]byte("state"))
	receiver.lockedUntil = time.Now().Add(150 * time.Millisecond)
	receiver.getDelay = 130 * time.Millisecond

	result, err := runSessionStateAction(context.Background(), receiver, sessionStateParams{Action: "get", SessionID: "session-42"}, 1000)
	if err != nil || !result.HasState {
		t.Fatalf("slow get result=%#v err=%v", result, err)
	}
	_, renewals, closes, _, _ := receiver.snapshot()
	if renewals == 0 || closes != 1 {
		t.Fatalf("renewals=%d closes=%d, want renewal and exactly one close", renewals, closes)
	}

	failing := newFakeSessionStateReceiver([]byte("state"))
	failing.lockedUntil = time.Now().Add(150 * time.Millisecond)
	failing.getDelay = 130 * time.Millisecond
	failing.renewErr = errors.New("session lock lost")
	_, err = runSessionStateAction(context.Background(), failing, sessionStateParams{Action: "get", SessionID: "session-42"}, 1000)
	if err == nil || !strings.Contains(err.Error(), "session lock lost") {
		t.Fatalf("expected renewal error, got %v", err)
	}
	_, renewals, closes, _, _ = failing.snapshot()
	if renewals == 0 || closes != 1 {
		t.Fatalf("failure renewals=%d closes=%d, want renewal attempt and close", renewals, closes)
	}
}

func TestSessionStateFrameBudgetLeavesEnvelopeRoom(t *testing.T) {
	encodedBytes := base64.StdEncoding.EncodedLen(maxSessionStateBytes)
	if encodedBytes+64*1024 > 32*1024*1024 {
		t.Fatalf("encoded state plus envelope reserve exceeds worker frame: %d", encodedBytes)
	}
	if maxSessionStateBytes <= 0 {
		t.Fatalf("invalid session state budget %d", maxSessionStateBytes)
	}
}
