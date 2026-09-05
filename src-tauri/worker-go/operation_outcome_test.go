package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
)

func TestOperationOutcomeCountsBothSourcesConcurrently(t *testing.T) {
	tracker := newOperationTracker()
	ctx := context.WithValue(context.Background(), outcomeContextKey{}, tracker)
	var workers sync.WaitGroup
	for _, source := range []string{"normal", "dlq"} {
		workers.Add(1)
		go func(source string) {
			defer workers.Done()
			for i := 0; i < 100; i++ {
				recordOperation(ctx, source, 1, 1, 0, 0)
			}
		}(source)
	}
	workers.Wait()
	result := tracker.finish("run", nil)
	if result.Counts.Sent != 200 || result.Counts.Settled != 200 || result.Counts.Sources["dlq"].Settled != 100 {
		t.Fatalf("incorrect aggregate: %+v", result.Counts)
	}
}

func TestSingleMoveOutcomeRetainsSendAfterSettlementFailure(t *testing.T) {
	tracker := newOperationTracker()
	ctx := context.WithValue(context.Background(), outcomeContextKey{}, tracker)
	receiver := &fakeSingleMessageActionReceiver{completeErr: map[int64]error{3: errors.New("acknowledgment lost")}}
	sender := &fakeSingleMessageSender{}
	seq := int64(3)
	target := peekTestMessages("message", seq)[0]
	err := performSingleMessageTargetAction(ctx, singleMessageActionParams{Action: "move", SequenceNumber: seq, IsDlq: true}, receiver, sender, target, false, 1000, nil)
	result := tracker.finish("run", err)
	if result.Status != "unknown" || result.Counts.Sent != 1 || result.Counts.Settled != 0 || result.Counts.SettlementUnconfirmed != 1 {
		t.Fatalf("lost partial outcome: %+v", result)
	}
}

func TestCancelledOutcomeWithAndWithoutUnconfirmedWork(t *testing.T) {
	tracker := newOperationTracker()
	if tracker.finish("run", context.Canceled).Status != "stopped" {
		t.Fatal("expected acknowledged stop")
	}
	ctx := context.WithValue(context.Background(), outcomeContextKey{}, tracker)
	recordOperation(ctx, "dlq", 0, 0, 1, 0)
	if tracker.finish("run", context.Canceled).Status != "unknown" {
		t.Fatal("cancellation cannot prove send failed")
	}
}

func TestSharedOperationOutcomeContract(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/operation-outcome.json")
	if err != nil {
		t.Fatal(err)
	}
	var result OperationOutcome
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Version != 1 || result.Status != "unknown" || result.Counts.Sent != 5 || result.Counts.Sources["dlq"].SettlementUnconfirmed != 1 {
		t.Fatalf("invalid fixture: %+v", result)
	}
}

func TestReplayMarksExactAttemptWithoutChangingSource(t *testing.T) {
	for _, regenerate := range []bool{false, true} {
		receiver := &fakeSingleMessageActionReceiver{}
		sender := &fakeSingleMessageSender{}
		target := peekTestMessages("message", 3)[0]
		target.ApplicationProperties = map[string]any{"BusmanReplayRunId": "earlier-attempt", "orderId": "42"}
		err := performSingleMessageTargetAction(context.Background(), singleMessageActionParams{
			Action: "replay", SequenceNumber: 3, IsDlq: true, RunID: "current-attempt",
		}, receiver, sender, target, regenerate, 1000, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(sender.messages) != 1 || sender.messages[0].ApplicationProperties["BusmanReplayRunId"] != "current-attempt" {
			t.Fatal("outbound replay did not carry the current attempt")
		}
		if target.ApplicationProperties["BusmanReplayRunId"] != "earlier-attempt" || sender.messages[0].ApplicationProperties["orderId"] != "42" {
			t.Fatal("replay changed source properties or lost application data")
		}
		if regenerate && *sender.messages[0].MessageID == target.MessageID {
			t.Fatal("duplicate-detection ID was not regenerated")
		}
		if len(receiver.completed) != 1 {
			t.Fatal("source was not completed after replay")
		}
	}
}
