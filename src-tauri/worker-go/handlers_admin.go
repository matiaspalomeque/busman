package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

const adminTimeout = 30 * time.Second

var ruleNameRe = regexp.MustCompile(`^[a-zA-Z0-9.$_\-/]+$`)

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
	go func() {
		defer wg.Done()
		runtimeResp, runtimeErr = adminClient.GetQueueRuntimeProperties(ctx, p.QueueName, nil)
	}()
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
		"name":                             p.QueueName,
		"lockDuration":                     derefString(qp.LockDuration),
		"maxSizeInMegabytes":               derefInt32(qp.MaxSizeInMegabytes),
		"requiresDuplicateDetection":       derefBool(qp.RequiresDuplicateDetection),
		"requiresSession":                  derefBool(qp.RequiresSession),
		"defaultMessageTimeToLive":         derefString(qp.DefaultMessageTimeToLive),
		"deadLetteringOnMessageExpiration": derefBool(qp.DeadLetteringOnMessageExpiration),
		"maxDeliveryCount":                 derefInt32(qp.MaxDeliveryCount),
		"enablePartitioning":               derefBool(qp.EnablePartitioning),
		"enableBatchedOperations":          derefBool(qp.EnableBatchedOperations),
		"status":                           derefStatus(qp.Status),
		"autoDeleteOnIdle":                 derefString(qp.AutoDeleteOnIdle),
		"forwardTo":                        derefString(qp.ForwardTo),
		"forwardDeadLetteredMessagesTo":    derefString(qp.ForwardDeadLetteredMessagesTo),
		"maxMessageSizeInKilobytes":        derefInt64(qp.MaxMessageSizeInKilobytes),
		// Runtime
		"sizeInBytes":                    rp.SizeInBytes,
		"createdAt":                      rp.CreatedAt.Format(time.RFC3339),
		"updatedAt":                      rp.UpdatedAt.Format(time.RFC3339),
		"accessedAt":                     rp.AccessedAt.Format(time.RFC3339),
		"totalMessageCount":              rp.TotalMessageCount,
		"activeMessageCount":             rp.ActiveMessageCount,
		"deadLetterMessageCount":         rp.DeadLetterMessageCount,
		"scheduledMessageCount":          rp.ScheduledMessageCount,
		"transferMessageCount":           rp.TransferMessageCount,
		"transferDeadLetterMessageCount": rp.TransferDeadLetterMessageCount,
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
	go func() {
		defer wg.Done()
		runtimeResp, runtimeErr = adminClient.GetTopicRuntimeProperties(ctx, p.TopicName, nil)
	}()
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
		"sizeInBytes":           rp.SizeInBytes,
		"createdAt":             rp.CreatedAt.Format(time.RFC3339),
		"updatedAt":             rp.UpdatedAt.Format(time.RFC3339),
		"accessedAt":            rp.AccessedAt.Format(time.RFC3339),
		"subscriptionCount":     rp.SubscriptionCount,
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
	go func() {
		defer wg.Done()
		propsResp, propsErr = adminClient.GetSubscription(ctx, p.TopicName, p.SubscriptionName, nil)
	}()
	go func() {
		defer wg.Done()
		runtimeResp, runtimeErr = adminClient.GetSubscriptionRuntimeProperties(ctx, p.TopicName, p.SubscriptionName, nil)
	}()
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
		"name":                             p.SubscriptionName,
		"topicName":                        p.TopicName,
		"lockDuration":                     derefString(sp.LockDuration),
		"requiresSession":                  derefBool(sp.RequiresSession),
		"defaultMessageTimeToLive":         derefString(sp.DefaultMessageTimeToLive),
		"deadLetteringOnMessageExpiration": derefBool(sp.DeadLetteringOnMessageExpiration),
		"enableDeadLetteringOnFilterEvaluationExceptions": derefBool(sp.EnableDeadLetteringOnFilterEvaluationExceptions),
		"maxDeliveryCount":              derefInt32(sp.MaxDeliveryCount),
		"status":                        derefStatus(sp.Status),
		"autoDeleteOnIdle":              derefString(sp.AutoDeleteOnIdle),
		"forwardTo":                     derefString(sp.ForwardTo),
		"forwardDeadLetteredMessagesTo": derefString(sp.ForwardDeadLetteredMessagesTo),
		"enableBatchedOperations":       derefBool(sp.EnableBatchedOperations),
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

// ─── subscription rules ─────────────────────────────────────────────────────

type subscriptionRuleParams struct {
	Env              map[string]string       `json:"env"`
	TopicName        string                  `json:"topicName"`
	SubscriptionName string                  `json:"subscriptionName"`
	Rule             subscriptionRulePayload `json:"rule"`
}

type deleteSubscriptionRuleParams struct {
	Env              map[string]string `json:"env"`
	TopicName        string            `json:"topicName"`
	SubscriptionName string            `json:"subscriptionName"`
	RuleName         string            `json:"ruleName"`
}

type subscriptionRulePayload struct {
	Name   string                         `json:"name"`
	Filter subscriptionRuleFilterPayload  `json:"filter"`
	Action *subscriptionRuleActionPayload `json:"action"`
}

type subscriptionRuleFilterPayload struct {
	Kind                  string         `json:"kind"`
	Expression            string         `json:"expression,omitempty"`
	Parameters            map[string]any `json:"parameters,omitempty"`
	ContentType           *string        `json:"contentType"`
	CorrelationID         *string        `json:"correlationId"`
	MessageID             *string        `json:"messageId"`
	ReplyTo               *string        `json:"replyTo"`
	ReplyToSessionID      *string        `json:"replyToSessionId"`
	SessionID             *string        `json:"sessionId"`
	Subject               *string        `json:"subject"`
	To                    *string        `json:"to"`
	ApplicationProperties map[string]any `json:"applicationProperties,omitempty"`
}

type subscriptionRuleActionPayload struct {
	Expression string         `json:"expression"`
	Parameters map[string]any `json:"parameters,omitempty"`
}

func validateSubscriptionTarget(topicName, subscriptionName string) error {
	if err := validateEntityName(topicName, "Topic"); err != nil {
		return err
	}
	if err := validateEntityName(subscriptionName, "Subscription"); err != nil {
		return err
	}
	return nil
}

func validateRuleName(name string) error {
	if name == "" {
		return fmt.Errorf("Rule name is required")
	}
	if len(name) > entityNameMaxLen {
		return fmt.Errorf("Rule name must be %d characters or less", entityNameMaxLen)
	}
	if !ruleNameRe.MatchString(name) {
		return fmt.Errorf("Rule name contains invalid characters. Allowed: alphanumeric, dot, dollar sign, underscore, hyphen, slash")
	}
	return nil
}

func handleListSubscriptionRules(raw json.RawMessage) (any, error) {
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
	if err := validateSubscriptionTarget(p.TopicName, p.SubscriptionName); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()

	pager := adminClient.NewListRulesPager(p.TopicName, p.SubscriptionName, nil)
	rules := make([]any, 0)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list subscription rules: %w", err)
		}
		for _, rule := range page.Rules {
			mapped, err := mapRuleProperties(rule)
			if err != nil {
				return nil, err
			}
			rules = append(rules, mapped)
		}
	}

	sort.Slice(rules, func(i, j int) bool {
		ri, _ := rules[i].(map[string]any)
		rj, _ := rules[j].(map[string]any)
		return fmt.Sprint(ri["name"]) < fmt.Sprint(rj["name"])
	})

	return map[string]any{
		"topicName":        p.TopicName,
		"subscriptionName": p.SubscriptionName,
		"rules":            rules,
	}, nil
}

func handleCreateSubscriptionRule(raw json.RawMessage) (any, error) {
	var p subscriptionRuleParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateSubscriptionTarget(p.TopicName, p.SubscriptionName); err != nil {
		return nil, err
	}
	opts, err := buildCreateRuleOptions(p.Rule)
	if err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	if _, err := adminClient.CreateRule(ctx, p.TopicName, p.SubscriptionName, opts); err != nil {
		return nil, fmt.Errorf("create subscription rule: %w", err)
	}
	return map[string]bool{"created": true}, nil
}

func handleUpdateSubscriptionRule(raw json.RawMessage) (any, error) {
	var p subscriptionRuleParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateSubscriptionTarget(p.TopicName, p.SubscriptionName); err != nil {
		return nil, err
	}
	props, err := buildRuleProperties(p.Rule)
	if err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	if _, err := adminClient.UpdateRule(ctx, p.TopicName, p.SubscriptionName, props); err != nil {
		return nil, fmt.Errorf("update subscription rule: %w", err)
	}
	return map[string]bool{"updated": true}, nil
}

func handleDeleteSubscriptionRule(raw json.RawMessage) (any, error) {
	var p deleteSubscriptionRuleParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	cs, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	if err := validateSubscriptionTarget(p.TopicName, p.SubscriptionName); err != nil {
		return nil, err
	}
	if err := validateRuleName(p.RuleName); err != nil {
		return nil, err
	}

	adminClient, err := getAdminClient(cs)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	if _, err := adminClient.DeleteRule(ctx, p.TopicName, p.SubscriptionName, p.RuleName, nil); err != nil {
		return nil, fmt.Errorf("delete subscription rule: %w", err)
	}
	return map[string]bool{"deleted": true}, nil
}

func mapRuleProperties(rule admin.RuleProperties) (map[string]any, error) {
	filter, err := mapRuleFilter(rule.Filter)
	if err != nil {
		return nil, err
	}

	result := map[string]any{
		"name":   rule.Name,
		"filter": filter,
		"action": nil,
	}
	if rule.Action != nil {
		action, err := mapRuleAction(rule.Action)
		if err != nil {
			return nil, err
		}
		result["action"] = action
	}
	return result, nil
}

func mapRuleFilter(filter admin.RuleFilter) (map[string]any, error) {
	switch f := filter.(type) {
	case *admin.SQLFilter:
		return map[string]any{
			"kind":       "sql",
			"expression": f.Expression,
			"parameters": normalizePrimitiveMap(f.Parameters),
		}, nil
	case *admin.CorrelationFilter:
		return map[string]any{
			"kind":                  "correlation",
			"contentType":           f.ContentType,
			"correlationId":         f.CorrelationID,
			"messageId":             f.MessageID,
			"replyTo":               f.ReplyTo,
			"replyToSessionId":      f.ReplyToSessionID,
			"sessionId":             f.SessionID,
			"subject":               f.Subject,
			"to":                    f.To,
			"applicationProperties": normalizePrimitiveMap(f.ApplicationProperties),
		}, nil
	case *admin.TrueFilter:
		return map[string]any{"kind": "true"}, nil
	case *admin.FalseFilter:
		return map[string]any{"kind": "false"}, nil
	case nil:
		return nil, fmt.Errorf("rule filter is required")
	default:
		return nil, fmt.Errorf("unsupported rule filter type %T", filter)
	}
}

func mapRuleAction(action admin.RuleAction) (map[string]any, error) {
	switch a := action.(type) {
	case *admin.SQLAction:
		return map[string]any{
			"expression": a.Expression,
			"parameters": normalizePrimitiveMap(a.Parameters),
		}, nil
	case nil:
		return nil, nil
	default:
		return nil, fmt.Errorf("unsupported rule action type %T", action)
	}
}

func buildCreateRuleOptions(rule subscriptionRulePayload) (*admin.CreateRuleOptions, error) {
	if err := validateRuleName(rule.Name); err != nil {
		return nil, err
	}
	filter, err := buildRuleFilter(rule.Filter)
	if err != nil {
		return nil, err
	}
	action, err := buildRuleAction(rule.Action)
	if err != nil {
		return nil, err
	}
	name := rule.Name
	return &admin.CreateRuleOptions{
		Name:   &name,
		Filter: filter,
		Action: action,
	}, nil
}

func buildRuleProperties(rule subscriptionRulePayload) (admin.RuleProperties, error) {
	if err := validateRuleName(rule.Name); err != nil {
		return admin.RuleProperties{}, err
	}
	filter, err := buildRuleFilter(rule.Filter)
	if err != nil {
		return admin.RuleProperties{}, err
	}
	action, err := buildRuleAction(rule.Action)
	if err != nil {
		return admin.RuleProperties{}, err
	}
	return admin.RuleProperties{
		Name:   rule.Name,
		Filter: filter,
		Action: action,
	}, nil
}

func buildRuleFilter(filter subscriptionRuleFilterPayload) (admin.RuleFilter, error) {
	switch filter.Kind {
	case "sql":
		if filter.Expression == "" {
			return nil, fmt.Errorf("SQL filter expression is required")
		}
		params, err := validatePrimitiveMap(filter.Parameters, "SQL filter parameters")
		if err != nil {
			return nil, err
		}
		return &admin.SQLFilter{
			Expression: filter.Expression,
			Parameters: params,
		}, nil
	case "correlation":
		appProps, err := validatePrimitiveMap(filter.ApplicationProperties, "Correlation application properties")
		if err != nil {
			return nil, err
		}
		return &admin.CorrelationFilter{
			ContentType:           normalizeOptionalString(filter.ContentType),
			CorrelationID:         normalizeOptionalString(filter.CorrelationID),
			MessageID:             normalizeOptionalString(filter.MessageID),
			ReplyTo:               normalizeOptionalString(filter.ReplyTo),
			ReplyToSessionID:      normalizeOptionalString(filter.ReplyToSessionID),
			SessionID:             normalizeOptionalString(filter.SessionID),
			Subject:               normalizeOptionalString(filter.Subject),
			To:                    normalizeOptionalString(filter.To),
			ApplicationProperties: appProps,
		}, nil
	case "true":
		return &admin.TrueFilter{}, nil
	case "false":
		return &admin.FalseFilter{}, nil
	default:
		return nil, fmt.Errorf("unsupported rule filter kind %q", filter.Kind)
	}
}

func buildRuleAction(action *subscriptionRuleActionPayload) (admin.RuleAction, error) {
	if action == nil {
		return nil, nil
	}
	if action.Expression == "" {
		return nil, fmt.Errorf("SQL action expression is required")
	}
	params, err := validatePrimitiveMap(action.Parameters, "SQL action parameters")
	if err != nil {
		return nil, err
	}
	return &admin.SQLAction{
		Expression: action.Expression,
		Parameters: params,
	}, nil
}

func normalizeOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	if *value == "" {
		return nil
	}
	return value
}

func normalizePrimitiveMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return map[string]any{}
	}
	result := make(map[string]any, len(source))
	for key, value := range source {
		normalized, ok := normalizePrimitiveValue(value)
		if ok {
			result[key] = normalized
		}
	}
	return result
}

func validatePrimitiveMap(source map[string]any, label string) (map[string]any, error) {
	if len(source) == 0 {
		return map[string]any{}, nil
	}
	result := make(map[string]any, len(source))
	for key, value := range source {
		normalized, ok := normalizePrimitiveValue(value)
		if !ok {
			return nil, fmt.Errorf("%s must contain only string, number, or boolean values", label)
		}
		result[key] = normalized
	}
	return result, nil
}

func normalizePrimitiveValue(value any) (any, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	case bool:
		return v, true
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int8:
		return float64(v), true
	case int16:
		return float64(v), true
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	case uint:
		return float64(v), true
	case uint8:
		return float64(v), true
	case uint16:
		return float64(v), true
	case uint32:
		return float64(v), true
	case uint64:
		return float64(v), true
	default:
		return nil, false
	}
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
