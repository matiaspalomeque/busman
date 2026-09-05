package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// Serialize single-message scans by broker source, across connection profiles.
var singleMessageSources sourceOperations

type sourceOperation struct {
	gate  chan struct{}
	users int
}

type sourceOperations struct {
	mu      sync.Mutex
	sources map[string]*sourceOperation
}

func singleMessageSourceKey(connectionString string, p singleMessageActionParams) string {
	endpoint := ""
	for _, part := range strings.Split(connectionString, ";") {
		key, value, ok := strings.Cut(part, "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "Endpoint") {
			endpoint = strings.TrimRight(strings.ToLower(strings.TrimSpace(value)), "/")
			break
		}
	}
	entity := "queue:" + p.QueueName
	if p.isSubscription() {
		entity = "subscription:" + p.TopicName + "/" + p.SubscriptionName
	}
	return fmt.Sprintf("%s\x00%s\x00%d", endpoint, strings.ToLower(entity), p.sourceSubQueue())
}

func (s *sourceOperations) acquire(ctx context.Context, key string) (func(), error) {
	s.mu.Lock()
	if s.sources == nil {
		s.sources = make(map[string]*sourceOperation)
	}
	source := s.sources[key]
	if source == nil {
		source = &sourceOperation{gate: make(chan struct{}, 1)}
		s.sources[key] = source
	}
	source.users++
	s.mu.Unlock()
	forget := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		source.users--
		if source.users == 0 {
			delete(s.sources, key)
		}
	}
	select {
	case source.gate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-source.gate
			forget()
			return nil, err
		}
		return func() { <-source.gate; forget() }, nil
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	}
}
