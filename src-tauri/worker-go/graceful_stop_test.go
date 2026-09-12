package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

type controlledSettlementReceiver struct {
	fakeSingleMessageActionReceiver
	complete func(context.Context, *azservicebus.ReceivedMessage) error
}

func (r *controlledSettlementReceiver) CompleteMessage(ctx context.Context, msg *azservicebus.ReceivedMessage, _ *azservicebus.CompleteMessageOptions) error {
	return r.complete(ctx, msg)
}

func stoppedTestRun(t *testing.T) (context.Context, *activeRun) {
	t.Helper()
	ctx, run, err := registerRun(t.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { finishRun(t.Name(), run) })
	return ctx, run
}

func TestGracefulStopFinishesOnlyInFlightRemovals(t *testing.T) {
	for _, concurrency := range []int{1, 3} {
		t.Run(fmt.Sprint(concurrency), func(t *testing.T) {
			ctx, run := stoppedTestRun(t)
			started := make(chan int64, concurrency)
			release := make(chan struct{})
			receiver := &controlledSettlementReceiver{complete: func(workCtx context.Context, msg *azservicebus.ReceivedMessage) error {
				started <- messageSequence(msg)
				select {
				case <-workCtx.Done():
					return workCtx.Err()
				case <-release:
					return nil
				}
			}}
			done := make(chan error, 1)
			go func() {
				_, err := completeReceivedMessages(ctx, receiver, peekTestMessages("drain", 1, 2, 3, 4, 5, 6), nil, 1000, concurrency, "dlq")
				done <- err
			}()
			for i := 0; i < concurrency; i++ {
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("removal did not start")
				}
			}
			if err := cancelRun(t.Name()); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				t.Fatalf("Stop returned a terminal result before confirming removals: %v", err)
			default:
			}
			if counts := run.tracker.snapshot(); counts.SettlementUnconfirmed != concurrency {
				t.Fatalf("queued messages counted as uncertain: %+v", counts)
			}
			close(release)
			select {
			case err := <-done:
				outcome := run.tracker.finish("run", err)
				if outcome.Status != "stopped" || outcome.Counts.Settled != concurrency || outcome.Counts.SettlementUnconfirmed != 0 {
					t.Fatalf("unexpected stopped result: %+v", outcome)
				}
			case <-time.After(time.Second):
				t.Fatal("Stop did not finish after acknowledgments")
			}
			if len(started) != 0 {
				t.Fatal("started another deletion after Stop")
			}
		})
	}
}

func TestStopBeforeRemovalDoesNotCreateUncertainty(t *testing.T) {
	ctx, run := stoppedTestRun(t)
	run.stop()
	receiver := &controlledSettlementReceiver{complete: func(context.Context, *azservicebus.ReceivedMessage) error {
		t.Error("deletion was dispatched after Stop")
		return nil
	}}
	_, err := completeReceivedMessages(ctx, receiver, peekTestMessages("drain", 1, 2, 3), nil, 1000, 3, "dlq")
	outcome := run.tracker.finish("run", err)
	if outcome.Status != "stopped" || outcome.Counts.SettlementUnconfirmed != 0 || outcome.Counts.Settled != 0 {
		t.Fatalf("unexpected result: %+v", outcome)
	}
}

func TestGracefulStopRetainsActualAcknowledgmentTimeout(t *testing.T) {
	ctx, run := stoppedTestRun(t)
	receiver := &controlledSettlementReceiver{complete: func(workCtx context.Context, _ *azservicebus.ReceivedMessage) error {
		run.stop()
		<-workCtx.Done()
		return workCtx.Err()
	}}
	_, err := completeReceivedMessages(ctx, receiver, peekTestMessages("drain", 1, 2, 3, 4), nil, 1000, 1, "dlq")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lost the real timeout: %v", err)
	}
	outcome := run.tracker.finish("run", errors.Join(err, ctx.Err()))
	if outcome.Status != "unknown" || outcome.ErrorCode != "cancelled" || outcome.Counts.SettlementUnconfirmed != 1 {
		t.Fatalf("uncertainty must cover only the dispatched request: %+v", outcome)
	}
}

func TestGracefulStopFinishesAcceptedTransferBeforeNextBatch(t *testing.T) {
	ctx, run := stoppedTestRun(t)
	receiver := &fakeSingleMessageActionReceiver{}
	messages := peekTestMessages("replay", 1, 2, 3)
	sent := 0
	send := func(sendCtx context.Context) error {
		sent++
		run.stop()
		return sendCtx.Err()
	}
	completed, err := sendAndCompleteMessages(ctx, receiver, messages, nil, 1000, 1, "dlq", send)
	if err != nil || completed != 3 {
		t.Fatalf("accepted batch was not settled after Stop: completed=%d err=%v", completed, err)
	}
	_, err = sendAndCompleteMessages(ctx, receiver, messages, nil, 1000, 1, "dlq", send)
	if !errors.Is(err, context.Canceled) || sent != 1 {
		t.Fatalf("another batch was sent after Stop: sends=%d err=%v", sent, err)
	}
	outcome := run.tracker.finish("run", ctx.Err())
	if outcome.Status != "stopped" || outcome.Counts.Sent != 3 || outcome.Counts.Settled != 3 || outcome.Counts.SettlementUnconfirmed != 0 {
		t.Fatalf("unexpected replay outcome: %+v", outcome)
	}
}

func TestAcceptedTransferRetainsRealSettlementFailure(t *testing.T) {
	ctx, run := stoppedTestRun(t)
	receiver := &fakeSingleMessageActionReceiver{completeErr: map[int64]error{1: errors.New("acknowledgment lost")}}
	_, err := sendAndCompleteMessages(ctx, receiver, peekTestMessages("replay", 1, 2, 3), nil, 1000, 1, "dlq", func(context.Context) error { return nil })
	outcome := run.tracker.finish("run", err)
	if outcome.Status != "unknown" || outcome.Counts.Sent != 3 || outcome.Counts.Settled != 0 || outcome.Counts.SettlementUnconfirmed != 1 {
		t.Fatalf("unexpected failed transfer: %+v", outcome)
	}
}

func TestAcceptedTransferInterruptedBeforeSettlementStillNeedsReview(t *testing.T) {
	ctx, run := stoppedTestRun(t)
	receiver := &controlledSettlementReceiver{complete: func(context.Context, *azservicebus.ReceivedMessage) error {
		t.Error("settlement was dispatched after the work context was cancelled")
		return nil
	}}
	_, err := sendAndCompleteMessages(ctx, receiver, peekTestMessages("replay", 1, 2, 3), nil, 1000, 1, "dlq", func(context.Context) error {
		// Unlike manual Stop, a lost lock or worker shutdown aborts active work.
		run.cancel()
		return nil
	})
	outcome := run.tracker.finish("run", err)
	if outcome.Status != "unknown" || outcome.Counts.Sent != 3 || outcome.Counts.Settled != 0 || outcome.Counts.SettlementUnconfirmed != 0 {
		t.Fatalf("accepted sends with sources left behind must remain visible for review: %+v", outcome)
	}
}

func TestSingleReplayStopKeepsTargetLockRenewalAndSettlement(t *testing.T) {
	ctx, run := stoppedTestRun(t)
	sendStarted := make(chan struct{})
	receiver := &fakeSingleMessageActionReceiver{receiveSteps: []fakeSingleReceiveStep{{messages: peekTestMessages("active", 3)}}}
	sender := &fakeSingleMessageSender{started: sendStarted, delay: 30 * time.Millisecond}
	go func() { <-sendStarted; run.stop() }()
	result, err := scanActiveSingleMessage(ctx, receiver, receiver, nil, 3, activeSingleMessageScanConfig{ScanBudget: 1, BatchSize: 1, MaxWaitMs: 1000, CleanupConcurrency: 1, LockRenewalInterval: time.Millisecond}, func(actionCtx context.Context, target *azservicebus.ReceivedMessage) error {
		return performSingleMessageTargetAction(actionCtx, singleMessageActionParams{Action: "replay", SequenceNumber: 3}, receiver, sender, target, false, 1000, nil)
	})
	if err != nil || !result.TargetHandled {
		t.Fatalf("single replay stopped mid-transfer: %+v %v", result, err)
	}
	outcome := run.tracker.finish("run", ctx.Err())
	if outcome.Status != "stopped" || outcome.Counts.Sent != 1 || outcome.Counts.Settled != 1 {
		t.Fatalf("unexpected single replay result: %+v", outcome)
	}
	_, _, _, renewed := receiver.snapshot()
	if len(renewed) == 0 {
		t.Fatal("target lock renewal stopped while the send was in flight")
	}
}
