package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

const adminTimeout = 30 * time.Second

// ─── createQueue ──────────────────────────────────────────────────────────────

type createQueueParams struct {
	Env     map[string]string `json:"env"`
	Name    string            `json:"name"`
	Options map[string]any    `json:"options"`
}

func handleCreateQueue(raw json.RawMessage) (any, error) {
	var p createQueueParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.Name, "Queue"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	opts := &admin.CreateQueueOptions{}
	props := &admin.QueueProperties{}

	if p.Options != nil {
		if v, ok := p.Options["maxSizeInMegabytes"].(float64); ok {
			i := int32(v)
			props.MaxSizeInMegabytes = &i
		}
		if v, ok := p.Options["defaultMessageTimeToLive"].(string); ok && v != "" {
			props.DefaultMessageTimeToLive = &v
		}
		if v, ok := p.Options["lockDuration"].(string); ok && v != "" {
			props.LockDuration = &v
		}
		if v, ok := p.Options["enablePartitioning"].(bool); ok {
			props.EnablePartitioning = &v
		}
		if v, ok := p.Options["requiresSession"].(bool); ok {
			props.RequiresSession = &v
		}
		if v, ok := p.Options["maxDeliveryCount"].(float64); ok {
			i := int32(v)
			props.MaxDeliveryCount = &i
		}
		if v, ok := p.Options["deadLetteringOnMessageExpiration"].(bool); ok {
			props.DeadLetteringOnMessageExpiration = &v
		}
	}
	opts.Properties = props

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_, err = adminClient.CreateQueue(ctx, p.Name, opts)
	if err != nil {
		return nil, fmt.Errorf("create queue error: %w", err)
	}
	return map[string]bool{"created": true}, nil
}

// ─── createTopic ──────────────────────────────────────────────────────────────

type createTopicParams struct {
	Env     map[string]string `json:"env"`
	Name    string            `json:"name"`
	Options map[string]any    `json:"options"`
}

func handleCreateTopic(raw json.RawMessage) (any, error) {
	var p createTopicParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.Name, "Topic"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	opts := &admin.CreateTopicOptions{}
	props := &admin.TopicProperties{}

	if p.Options != nil {
		if v, ok := p.Options["maxSizeInMegabytes"].(float64); ok {
			i := int32(v)
			props.MaxSizeInMegabytes = &i
		}
		if v, ok := p.Options["defaultMessageTimeToLive"].(string); ok && v != "" {
			props.DefaultMessageTimeToLive = &v
		}
		if v, ok := p.Options["enablePartitioning"].(bool); ok {
			props.EnablePartitioning = &v
		}
	}
	opts.Properties = props

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_, err = adminClient.CreateTopic(ctx, p.Name, opts)
	if err != nil {
		return nil, fmt.Errorf("create topic error: %w", err)
	}
	return map[string]bool{"created": true}, nil
}

// ─── createSubscription ──────────────────────────────────────────────────────

type createSubscriptionParams struct {
	Env              map[string]string `json:"env"`
	TopicName        string            `json:"topicName"`
	SubscriptionName string            `json:"subscriptionName"`
	Options          map[string]any    `json:"options"`
}

func handleCreateSubscription(raw json.RawMessage) (any, error) {
	var p createSubscriptionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.TopicName, "Topic"); err != nil {
		return nil, err
	}
	if err := validateEntityName(p.SubscriptionName, "Subscription"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	opts := &admin.CreateSubscriptionOptions{}
	props := &admin.SubscriptionProperties{}

	if p.Options != nil {
		if v, ok := p.Options["defaultMessageTimeToLive"].(string); ok && v != "" {
			props.DefaultMessageTimeToLive = &v
		}
		if v, ok := p.Options["lockDuration"].(string); ok && v != "" {
			props.LockDuration = &v
		}
		if v, ok := p.Options["maxDeliveryCount"].(float64); ok {
			i := int32(v)
			props.MaxDeliveryCount = &i
		}
		if v, ok := p.Options["deadLetteringOnMessageExpiration"].(bool); ok {
			props.DeadLetteringOnMessageExpiration = &v
		}
		if v, ok := p.Options["requiresSession"].(bool); ok {
			props.RequiresSession = &v
		}
	}
	opts.Properties = props

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_, err = adminClient.CreateSubscription(ctx, p.TopicName, p.SubscriptionName, opts)
	if err != nil {
		return nil, fmt.Errorf("create subscription error: %w", err)
	}
	return map[string]bool{"created": true}, nil
}

// ─── deleteQueue ─────────────────────────────────────────────────────────────

type deleteEntityParams struct {
	Env  map[string]string `json:"env"`
	Name string            `json:"name"`
}

func handleDeleteQueue(raw json.RawMessage) (any, error) {
	var p deleteEntityParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.Name, "Queue"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_, err = adminClient.DeleteQueue(ctx, p.Name, nil)
	if err != nil {
		return nil, fmt.Errorf("delete queue error: %w", err)
	}
	return map[string]bool{"deleted": true}, nil
}

// ─── deleteTopic ─────────────────────────────────────────────────────────────

func handleDeleteTopic(raw json.RawMessage) (any, error) {
	var p deleteEntityParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.Name, "Topic"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_, err = adminClient.DeleteTopic(ctx, p.Name, nil)
	if err != nil {
		return nil, fmt.Errorf("delete topic error: %w", err)
	}
	return map[string]bool{"deleted": true}, nil
}

// ─── deleteSubscription ──────────────────────────────────────────────────────

type deleteSubscriptionParams struct {
	Env              map[string]string `json:"env"`
	TopicName        string            `json:"topicName"`
	SubscriptionName string            `json:"subscriptionName"`
}

func handleDeleteSubscription(raw json.RawMessage) (any, error) {
	var p deleteSubscriptionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.TopicName, "Topic"); err != nil {
		return nil, err
	}
	if err := validateEntityName(p.SubscriptionName, "Subscription"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_, err = adminClient.DeleteSubscription(ctx, p.TopicName, p.SubscriptionName, nil)
	if err != nil {
		return nil, fmt.Errorf("delete subscription error: %w", err)
	}
	return map[string]bool{"deleted": true}, nil
}

// ─── getQueueProperties ─────────────────────────────────────────────────────

func handleGetQueueProperties(raw json.RawMessage) (any, error) {
	var p struct {
		Env       map[string]string `json:"env"`
		QueueName string            `json:"queueName"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.QueueName, "Queue"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()

	var (
		propsResp   *admin.GetQueueResponse
		runtimeResp *admin.GetQueueRuntimePropertiesResponse
		propsErr    error
		runtimeErr  error
	)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); propsResp, propsErr = adminClient.GetQueue(ctx, p.QueueName, nil) }()
	go func() { defer wg.Done(); runtimeResp, runtimeErr = adminClient.GetQueueRuntimeProperties(ctx, p.QueueName, nil) }()
	wg.Wait()
	if propsErr != nil {
		return nil, fmt.Errorf("get queue properties: %w", propsErr)
	}
	if runtimeErr != nil {
		return nil, fmt.Errorf("get queue runtime properties: %w", runtimeErr)
	}

	qp := propsResp.QueueProperties
	rp := runtimeResp

	return map[string]any{
		"name":                            p.QueueName,
		"lockDuration":                    derefString(qp.LockDuration),
		"maxSizeInMegabytes":              derefInt32(qp.MaxSizeInMegabytes),
		"requiresDuplicateDetection":      derefBool(qp.RequiresDuplicateDetection),
		"requiresSession":                 derefBool(qp.RequiresSession),
		"defaultMessageTimeToLive":        derefString(qp.DefaultMessageTimeToLive),
		"deadLetteringOnMessageExpiration": derefBool(qp.DeadLetteringOnMessageExpiration),
		"maxDeliveryCount":                derefInt32(qp.MaxDeliveryCount),
		"enablePartitioning":              derefBool(qp.EnablePartitioning),
		"enableBatchedOperations":         derefBool(qp.EnableBatchedOperations),
		"status":                          derefStatus(qp.Status),
		"autoDeleteOnIdle":                derefString(qp.AutoDeleteOnIdle),
		"forwardTo":                       derefString(qp.ForwardTo),
		"forwardDeadLetteredMessagesTo":   derefString(qp.ForwardDeadLetteredMessagesTo),
		"maxMessageSizeInKilobytes":       derefInt64(qp.MaxMessageSizeInKilobytes),
		// Runtime
		"sizeInBytes":                      rp.SizeInBytes,
		"createdAt":                        rp.CreatedAt.Format(time.RFC3339),
		"updatedAt":                        rp.UpdatedAt.Format(time.RFC3339),
		"accessedAt":                       rp.AccessedAt.Format(time.RFC3339),
		"totalMessageCount":                rp.TotalMessageCount,
		"activeMessageCount":               rp.ActiveMessageCount,
		"deadLetterMessageCount":           rp.DeadLetterMessageCount,
		"scheduledMessageCount":            rp.ScheduledMessageCount,
		"transferMessageCount":             rp.TransferMessageCount,
		"transferDeadLetterMessageCount":   rp.TransferDeadLetterMessageCount,
	}, nil
}

// ─── getTopicProperties ─────────────────────────────────────────────────────

func handleGetTopicProperties(raw json.RawMessage) (any, error) {
	var p struct {
		Env       map[string]string `json:"env"`
		TopicName string            `json:"topicName"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.TopicName, "Topic"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()

	var (
		propsResp   *admin.GetTopicResponse
		runtimeResp *admin.GetTopicRuntimePropertiesResponse
		propsErr    error
		runtimeErr  error
	)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); propsResp, propsErr = adminClient.GetTopic(ctx, p.TopicName, nil) }()
	go func() { defer wg.Done(); runtimeResp, runtimeErr = adminClient.GetTopicRuntimeProperties(ctx, p.TopicName, nil) }()
	wg.Wait()
	if propsErr != nil {
		return nil, fmt.Errorf("get topic properties: %w", propsErr)
	}
	if runtimeErr != nil {
		return nil, fmt.Errorf("get topic runtime properties: %w", runtimeErr)
	}

	tp := propsResp.TopicProperties
	rp := runtimeResp

	return map[string]any{
		"name":                       p.TopicName,
		"maxSizeInMegabytes":         derefInt32(tp.MaxSizeInMegabytes),
		"requiresDuplicateDetection": derefBool(tp.RequiresDuplicateDetection),
		"defaultMessageTimeToLive":   derefString(tp.DefaultMessageTimeToLive),
		"enablePartitioning":         derefBool(tp.EnablePartitioning),
		"enableBatchedOperations":    derefBool(tp.EnableBatchedOperations),
		"status":                     derefStatus(tp.Status),
		"autoDeleteOnIdle":           derefString(tp.AutoDeleteOnIdle),
		"supportOrdering":            derefBool(tp.SupportOrdering),
		"maxMessageSizeInKilobytes":  derefInt64(tp.MaxMessageSizeInKilobytes),
		// Runtime
		"sizeInBytes":          rp.SizeInBytes,
		"createdAt":            rp.CreatedAt.Format(time.RFC3339),
		"updatedAt":            rp.UpdatedAt.Format(time.RFC3339),
		"accessedAt":           rp.AccessedAt.Format(time.RFC3339),
		"subscriptionCount":    rp.SubscriptionCount,
		"scheduledMessageCount": rp.ScheduledMessageCount,
	}, nil
}

// ─── getSubscriptionProperties ──────────────────────────────────────────────

func handleGetSubscriptionProperties(raw json.RawMessage) (any, error) {
	var p struct {
		Env              map[string]string `json:"env"`
		TopicName        string            `json:"topicName"`
		SubscriptionName string            `json:"subscriptionName"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateEntityName(p.TopicName, "Topic"); err != nil {
		return nil, err
	}
	if err := validateEntityName(p.SubscriptionName, "Subscription"); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()

	var (
		propsResp   *admin.GetSubscriptionResponse
		runtimeResp *admin.GetSubscriptionRuntimePropertiesResponse
		propsErr    error
		runtimeErr  error
	)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); propsResp, propsErr = adminClient.GetSubscription(ctx, p.TopicName, p.SubscriptionName, nil) }()
	go func() { defer wg.Done(); runtimeResp, runtimeErr = adminClient.GetSubscriptionRuntimeProperties(ctx, p.TopicName, p.SubscriptionName, nil) }()
	wg.Wait()
	if propsErr != nil {
		return nil, fmt.Errorf("get subscription properties: %w", propsErr)
	}
	if runtimeErr != nil {
		return nil, fmt.Errorf("get subscription runtime properties: %w", runtimeErr)
	}

	sp := propsResp.SubscriptionProperties
	rp := runtimeResp

	return map[string]any{
		"name":      p.SubscriptionName,
		"topicName": p.TopicName,
		"lockDuration":                    derefString(sp.LockDuration),
		"requiresSession":                 derefBool(sp.RequiresSession),
		"defaultMessageTimeToLive":        derefString(sp.DefaultMessageTimeToLive),
		"deadLetteringOnMessageExpiration": derefBool(sp.DeadLetteringOnMessageExpiration),
		"enableDeadLetteringOnFilterEvaluationExceptions": derefBool(sp.EnableDeadLetteringOnFilterEvaluationExceptions),
		"maxDeliveryCount":                derefInt32(sp.MaxDeliveryCount),
		"status":                          derefStatus(sp.Status),
		"autoDeleteOnIdle":                derefString(sp.AutoDeleteOnIdle),
		"forwardTo":                       derefString(sp.ForwardTo),
		"forwardDeadLetteredMessagesTo":   derefString(sp.ForwardDeadLetteredMessagesTo),
		"enableBatchedOperations":         derefBool(sp.EnableBatchedOperations),
		// Runtime
		"createdAt":                      rp.CreatedAt.Format(time.RFC3339),
		"updatedAt":                      rp.UpdatedAt.Format(time.RFC3339),
		"accessedAt":                     rp.AccessedAt.Format(time.RFC3339),
		"totalMessageCount":              rp.TotalMessageCount,
		"activeMessageCount":             rp.ActiveMessageCount,
		"deadLetterMessageCount":         rp.DeadLetterMessageCount,
		"transferMessageCount":           rp.TransferMessageCount,
		"transferDeadLetterMessageCount": rp.TransferDeadLetterMessageCount,
	}, nil
}

// ─── Pointer dereference helpers ────────────────────────────────────────────

func derefBool(p *bool) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefInt32(p *int32) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefStatus(p *admin.EntityStatus) any {
	if p == nil {
		return nil
	}
	return string(*p)
}
