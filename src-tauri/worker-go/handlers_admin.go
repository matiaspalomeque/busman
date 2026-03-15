package main

import (
	"context"
	"encoding/json"
	"fmt"
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

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
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

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
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

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
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

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
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

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
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

	adminClient, err := admin.NewClientFromConnectionString(cs, nil)
	if err != nil {
		return nil, fmt.Errorf("admin client error: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	_, err = adminClient.DeleteSubscription(ctx, p.TopicName, p.SubscriptionName, nil)
	if err != nil {
		return nil, fmt.Errorf("delete subscription error: %w", err)
	}
	return map[string]bool{"deleted": true}, nil
}
