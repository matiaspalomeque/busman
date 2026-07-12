package main

import (
	"context"
	"testing"
	"time"
)

func TestCancelRunTargetsOnlyRequestedOperation(t *testing.T) {
	ctxA, runA, err := registerRun("run-a")
	if err != nil {
		t.Fatalf("register run-a: %v", err)
	}
	ctxB, runB, err := registerRun("run-b")
	if err != nil {
		t.Fatalf("register run-b: %v", err)
	}
	defer finishRun("run-b", runB)

	go func() {
		<-ctxA.Done()
		finishRun("run-a", runA)
	}()

	if err := cancelRun("run-a"); err != nil {
		t.Fatalf("cancel run-a: %v", err)
	}
	if ctxA.Err() != context.Canceled {
		t.Fatalf("run-a context error = %v, want context.Canceled", ctxA.Err())
	}
	select {
	case <-ctxB.Done():
		t.Fatal("cancelling run-a also cancelled run-b")
	case <-time.After(10 * time.Millisecond):
	}
}

func TestCancelRunRejectsUnknownRun(t *testing.T) {
	if err := cancelRun("missing-run"); err == nil {
		t.Fatal("cancelRun should reject an unknown run")
	}
}

func TestRunIDFromParams(t *testing.T) {
	if got := runIDFromParams([]byte(`{"runId":"run-42"}`)); got != "run-42" {
		t.Fatalf("runIDFromParams = %q, want run-42", got)
	}
	if got := runIDFromParams([]byte(`not-json`)); got != "" {
		t.Fatalf("invalid params returned run ID %q", got)
	}
}
