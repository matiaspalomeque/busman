package main

import (
	"encoding/json"
	"testing"
)

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
			_, err := handleRepublishSubscriptionDlq(raw)
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error, got: %v", err)
			}
		})
	}
}
