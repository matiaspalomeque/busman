package main

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Unconfirmed counts are upper bounds, not confirmed failures. A lost broker
// acknowledgment can follow a successful send or completion.
type SourceOutcome struct {
	Sent                  int `json:"sent"`
	Settled               int `json:"settled"`
	SendUnconfirmed       int `json:"sendUnconfirmed"`
	SettlementUnconfirmed int `json:"settlementUnconfirmed"`
}

type OperationCounts struct {
	SourceOutcome
	Sources map[string]SourceOutcome `json:"sources"`
}

type OperationOutcome struct {
	Version      int             `json:"version"`
	RunID        string          `json:"runId"`
	Status       string          `json:"status"`
	StartedAt    string          `json:"startedAt"`
	FinishedAt   string          `json:"finishedAt"`
	Counts       OperationCounts `json:"counts"`
	ErrorCode    string          `json:"errorCode,omitempty"`
	ErrorMessage string          `json:"errorMessage,omitempty"`
}

type outcomeContextKey struct{}
type operationTracker struct {
	sync.Mutex
	started time.Time
	sources map[string]SourceOutcome
}

func newOperationTracker() *operationTracker {
	return &operationTracker{started: time.Now(), sources: make(map[string]SourceOutcome)}
}

func recordOperation(ctx context.Context, source string, sent, settled, sendUnconfirmed, settlementUnconfirmed int) {
	tracker, _ := ctx.Value(outcomeContextKey{}).(*operationTracker)
	if tracker == nil {
		return
	}
	tracker.Lock()
	defer tracker.Unlock()
	value := tracker.sources[source]
	value.Sent += sent
	value.Settled += settled
	value.SendUnconfirmed += sendUnconfirmed
	value.SettlementUnconfirmed += settlementUnconfirmed
	tracker.sources[source] = value
}

func (tracker *operationTracker) snapshot() OperationCounts {
	tracker.Lock()
	defer tracker.Unlock()
	result := OperationCounts{Sources: make(map[string]SourceOutcome)}
	for source, value := range tracker.sources {
		result.Sources[source] = value
		result.Sent += value.Sent
		result.Settled += value.Settled
		result.SendUnconfirmed += value.SendUnconfirmed
		result.SettlementUnconfirmed += value.SettlementUnconfirmed
	}
	return result
}

func (tracker *operationTracker) finish(runID string, err error) OperationOutcome {
	result := OperationOutcome{Version: 1, RunID: runID, Status: "success", StartedAt: tracker.started.UTC().Format(time.RFC3339Nano), FinishedAt: time.Now().UTC().Format(time.RFC3339Nano), Counts: tracker.snapshot()}
	if err != nil {
		result.Status, result.ErrorCode, result.ErrorMessage = "error", "operation_failed", err.Error()
		if errors.Is(err, context.Canceled) {
			result.Status, result.ErrorCode = "stopped", "cancelled"
		}
		if result.Counts.SendUnconfirmed > 0 || result.Counts.SettlementUnconfirmed > 0 {
			result.Status, result.ErrorCode = "unknown", "broker_acknowledgment_unknown"
		}
	}
	return result
}

func operationCounts(runID string) *OperationCounts {
	activeRuns.Lock()
	run := activeRuns.runs[runID]
	activeRuns.Unlock()
	if run == nil || run.tracker == nil {
		return nil
	}
	counts := run.tracker.snapshot()
	return &counts
}

func hasStructuredOutcome(method string) bool {
	switch method {
	case "emptyMessages", "moveMessages", "republishSubscriptionDlq", "singleMessageAction":
		return true
	default:
		return false
	}
}
