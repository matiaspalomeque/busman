package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

// ─── 7. sendMessage ──────────────────────────────────────────────────────────

type sendMessageParams struct {
	EntityName string            `json:"entityName"`
	EntityKind string            `json:"entityKind"`
	Env        map[string]string `json:"env"`
	Message    map[string]any    `json:"message"`
}

type queueSessionAdmin interface {
	GetQueue(context.Context, string, *admin.GetQueueOptions) (*admin.GetQueueResponse, error)
}

func validateSendSessionRequirement(
	ctx context.Context,
	client queueSessionAdmin,
	entityKind string,
	entityName string,
	sessionID string,
) error {
	switch entityKind {
	case "topic":
		// Session requirements belong to subscriptions, not the topic sender.
		return nil
	case "queue":
	default:
		return fmt.Errorf("entityKind must be queue or topic")
	}

	response, err := client.GetQueue(ctx, entityName, nil)
	if err != nil {
		return fmt.Errorf("read queue session requirement: %w", err)
	}
	if response == nil {
		return fmt.Errorf("queue %q was not found", entityName)
	}
	if response.RequiresSession != nil && *response.RequiresSession && strings.TrimSpace(sessionID) == "" {
		return fmt.Errorf("queue %q requires sessions; enter a non-blank Session Id before sending", entityName)
	}
	return nil
}

func handleSendMessage(raw json.RawMessage) (any, error) {
	var p sendMessageParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.EntityName, "Entity"); err != nil {
		return nil, err
	}
	if p.EntityKind == "" {
		// Backward-compatible worker default for callers predating entityKind.
		p.EntityKind = "queue"
	}

	msg := p.Message
	if msg == nil {
		msg = map[string]any{}
	}
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 60000)
	sessionID, _ := msg["sessionId"].(string)
	if p.EntityKind == "queue" {
		adminClient, err := getAdminClient(cs)
		if err != nil {
			return nil, err
		}
		checkCtx, checkCancel := context.WithTimeout(context.Background(), time.Duration(maxWaitMs)*time.Millisecond)
		err = validateSendSessionRequirement(checkCtx, adminClient, p.EntityKind, p.EntityName, sessionID)
		checkCancel()
		if err != nil {
			return nil, fmt.Errorf("cannot safely send to queue %q: %w", p.EntityName, err)
		}
	} else if err := validateSendSessionRequirement(context.Background(), nil, p.EntityKind, p.EntityName, sessionID); err != nil {
		return nil, err
	}

	// Body: if contentType is application/json, try to parse → re-encode for clean bytes.
	bodyStr, _ := msg["body"].(string)
	body := []byte(bodyStr)
	if ct, _ := msg["contentType"].(string); strings.Contains(ct, "application/json") {
		var jsonVal any
		if err := json.Unmarshal(body, &jsonVal); err == nil {
			if b, err := json.Marshal(jsonVal); err == nil {
				body = b
			}
		}
	}

	sbMsg := &azservicebus.Message{Body: body}

	if v, _ := msg["contentType"].(string); v != "" {
		sbMsg.ContentType = &v
	}
	if v, _ := msg["subject"].(string); v != "" {
		sbMsg.Subject = &v
	}
	if v, _ := msg["messageId"].(string); v != "" {
		sbMsg.MessageID = &v
	}
	if v, _ := msg["correlationId"].(string); v != "" {
		sbMsg.CorrelationID = &v
	}
	if v, _ := msg["sessionId"].(string); v != "" {
		sbMsg.SessionID = &v
	}
	if v, ok := msg["applicationProperties"].(map[string]any); ok {
		sbMsg.ApplicationProperties = v
	}
	if v, _ := msg["scheduledEnqueueTimeUtc"].(string); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return nil, fmt.Errorf("scheduledEnqueueTimeUtc must be an RFC3339 timestamp: %w", err)
		}
		sbMsg.ScheduledEnqueueTime = &t
	}

	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer closeWithTimeout(client)

	sender, err := client.NewSender(p.EntityName, nil)
	if err != nil {
		return nil, fmt.Errorf("sender error: %w", err)
	}
	defer closeWithTimeout(sender)

	sendCtx, sendCancel := context.WithTimeout(context.Background(), time.Duration(maxWaitMs)*time.Millisecond)
	defer sendCancel()
	if err := sender.SendMessage(sendCtx, sbMsg, nil); err != nil {
		return nil, fmt.Errorf("send error: %w", err)
	}
	return map[string]bool{"sent": true}, nil
}
