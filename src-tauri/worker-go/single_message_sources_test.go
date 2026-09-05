package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSingleMessageSourcesWaitForCleanup(t *testing.T) {
	var sources sourceOperations
	release, err := sources.acquire(context.Background(), "orders-dlq")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	acquired := make(chan func(), 1)
	go func() {
		next, err := sources.acquire(ctx, "orders-dlq")
		if err == nil {
			acquired <- next
		}
	}()
	select {
	case next := <-acquired:
		next()
		t.Fatal("overlapping scan acquired a source before cleanup")
	case <-time.After(20 * time.Millisecond):
	}
	// Work on another source can still proceed while the first is held.
	other, err := sources.acquire(ctx, "billing-dlq")
	if err != nil {
		t.Fatal(err)
	}
	other()
	release()
	select {
	case next := <-acquired:
		next()
	case <-ctx.Done():
		t.Fatal("waiting scan did not resume after cleanup")
	}
	if len(sources.sources) != 0 {
		t.Fatal("source gates were not released")
	}
}

func TestSingleMessageSourcesCancelWhileWaiting(t *testing.T) {
	var sources sourceOperations
	release, _ := sources.acquire(context.Background(), "orders")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := sources.acquire(ctx, "orders"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	release()
	if len(sources.sources) != 0 {
		t.Fatal("cancelled waiter leaked its source gate")
	}
}

func TestSingleMessageSourceKeyUsesBrokerSource(t *testing.T) {
	p := singleMessageActionParams{QueueName: "Orders", IsDlq: true}
	key := singleMessageSourceKey("Endpoint=sb://TEST/;SharedAccessKey=a", p)
	if key != singleMessageSourceKey("Endpoint=sb://test;SharedAccessKey=b", p) {
		t.Fatal("profiles for the same source must share a gate")
	}
	for _, other := range []singleMessageActionParams{
		{QueueName: "billing", IsDlq: true},
		{QueueName: "Orders"},
		{QueueName: "Orders", IsDlq: true, SourceSubQueue: "transferDeadLetter"},
		{subscriptionSource: subscriptionSource{TopicName: "Orders", SubscriptionName: "worker"}, IsDlq: true},
	} {
		if key == singleMessageSourceKey("Endpoint=sb://test", other) {
			t.Fatal("distinct sources shared a gate")
		}
	}
}
