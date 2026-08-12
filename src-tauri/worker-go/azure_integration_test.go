package main

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

// This suite is intentionally excluded from default CI by its explicit credential gate.
// Run it against a disposable namespace with Manage, Send, and Listen rights:
//
//	BUSMAN_AZURE_INTEGRATION_CONNECTION_STRING='Endpoint=sb://...' \
//	BUSMAN_AZURE_INTEGRATION_EXPECTED_NAMESPACE='my-test-namespace' \
//	go test -run '^TestAzureServiceBusIntegration$' -v ./...
//
// BUSMAN_AZURE_INTEGRATION_EXPECTED_NAMESPACE is optional and accepts either the
// short namespace name or its full Service Bus hostname.

const (
	azureIntegrationConnectionStringEnv  = "BUSMAN_AZURE_INTEGRATION_CONNECTION_STRING"
	azureIntegrationExpectedNamespaceEnv = "BUSMAN_AZURE_INTEGRATION_EXPECTED_NAMESPACE"
	azureIntegrationTimeout              = 90 * time.Second
)

var (
	azureIntegrationOwnedNameRE = regexp.MustCompile(`^busman-it-[0-9a-f]+-[0-9a-f]{8}-[a-z0-9-]+$`)
	azureIntegrationSuffixRE    = regexp.MustCompile(`^[a-z0-9-]+$`)
	azureIntegrationSecretRE    = regexp.MustCompile(`(?i)(sharedaccesskey|sharedaccesssignature|sig)=([^;\s&]+)`)
)

type azureIntegrationConfig struct {
	connectionString string
	namespace        string
}

type azureIntegrationFixture struct {
	t      *testing.T
	config azureIntegrationConfig
	admin  *admin.Client
	prefix string

	queues        map[string]struct{}
	topics        map[string]struct{}
	subscriptions map[string]struct{}
}

type azureIntegrationEntity struct {
	queue        string
	topic        string
	subscription string
}

type azureIntegrationMessage struct {
	id           string
	body         string
	partitionKey string
	sessionID    string
}

func TestAzureServiceBusIntegration(t *testing.T) {
	config := loadAzureIntegrationConfig(t)
	t.Logf("running opt-in Service Bus integration suite against namespace %s", config.namespace)

	t.Run("both browsing shows active and dead-letter messages", func(t *testing.T) {
		cases := []struct {
			name string
			kind string
		}{
			{name: "queue", kind: "queue"},
			{name: "subscription", kind: "subscription"},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				fixture := newAzureIntegrationFixture(t, config)
				var entity azureIntegrationEntity
				if tc.kind == "queue" {
					entity.queue = fixture.createQueue(t, "browse-queue", &admin.QueueProperties{}, "queues")
				} else {
					entity.topic = fixture.createTopic(t, "browse-topic", &admin.TopicProperties{}, "topics")
					entity.subscription = fixture.createSubscription(t, entity.topic, "browse-sub", &admin.SubscriptionProperties{}, "subscriptions")
				}

				activeID := "browse-active"
				dlqID := "browse-dlq"
				fixture.sendViaWorker(t, entity.sendEntity(), dlqID, "", `{"state":"dlq"}`)
				fixture.deadLetterOne(t, entity, dlqID, "")
				fixture.sendViaWorker(t, entity.sendEntity(), activeID, "", `{"state":"active"}`)
				fixture.waitForCounts(t, entity, 1, 1)

				argv := []string{"queue", entity.queue, "10", "both"}
				if entity.topic != "" {
					argv = []string{"topic", entity.topic, entity.subscription, "10", "both"}
				}
				result := fixture.mustCallWorker(t, "peekMessages", map[string]any{
					"argv": argv,
					"env":  fixture.workerEnv(),
				})
				messages := integrationMessageRecords(t, result)
				assertIntegrationBrowseSources(t, messages, map[string]string{
					activeID: "active",
					dlqID:    "deadLetter",
				})
			})
		}
	})

	t.Run("session sources move normal and dead-letter messages", func(t *testing.T) {
		cases := []struct {
			name string
			kind string
		}{
			{name: "session queue", kind: "queue"},
			{name: "session subscription", kind: "subscription"},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				fixture := newAzureIntegrationFixture(t, config)
				requiresSession := true
				destination := fixture.createQueue(t, "session-dest", &admin.QueueProperties{
					RequiresSession: &requiresSession,
				}, "session queues")

				var source azureIntegrationEntity
				if tc.kind == "queue" {
					source.queue = fixture.createQueue(t, "session-source", &admin.QueueProperties{
						RequiresSession: &requiresSession,
					}, "session queues")
				} else {
					source.topic = fixture.createTopic(t, "session-topic", &admin.TopicProperties{}, "topics")
					source.subscription = fixture.createSubscription(t, source.topic, "session-sub", &admin.SubscriptionProperties{
						RequiresSession: &requiresSession,
					}, "session subscriptions")
				}

				activeSession := "session-active"
				dlqSession := "session-dlq"
				activeID := "session-active-message"
				dlqID := "session-dlq-message"
				fixture.sendViaWorker(t, source.sendEntity(), dlqID, dlqSession, `{"state":"dlq"}`)
				fixture.deadLetterOne(t, source, dlqID, dlqSession)
				fixture.sendViaWorker(t, source.sendEntity(), activeID, activeSession, `{"state":"active"}`)
				fixture.waitForCounts(t, source, 1, 1)

				params := map[string]any{
					"sourceQueue": source.queue,
					"destQueue":   destination,
					"mode":        "both",
					"env":         fixture.workerEnv(),
				}
				if source.topic != "" {
					params["topicName"] = source.topic
					params["subscriptionName"] = source.subscription
				}
				result := fixture.mustCallWorker(t, "moveMessages", params)
				if got := integrationInt(t, result, "totalMoved"); got != 2 {
					t.Fatalf("totalMoved = %d, want 2", got)
				}

				fixture.waitForCounts(t, source, 0, 0)
				fixture.waitForCounts(t, azureIntegrationEntity{queue: destination}, 2, 0)
				messages := append(
					fixture.receiveQueueMessages(t, destination, activeSession, 1),
					fixture.receiveQueueMessages(t, destination, dlqSession, 1)...,
				)
				assertIntegrationMessageIDs(t, messages, activeID, dlqID)
			})
		}
	})

	t.Run("bulk DLQ replay survives duplicate detection", func(t *testing.T) {
		fixture := newAzureIntegrationFixture(t, config)
		requiresDuplicateDetection := true
		historyWindow := "PT10M"
		queue := fixture.createQueue(t, "duplicate-replay", &admin.QueueProperties{
			RequiresDuplicateDetection:          &requiresDuplicateDetection,
			DuplicateDetectionHistoryTimeWindow: &historyWindow,
		}, "duplicate detection")
		entity := azureIntegrationEntity{queue: queue}

		originalIDs := []string{"duplicate-replay-a", "duplicate-replay-b"}
		for _, id := range originalIDs {
			fixture.sendViaWorker(t, queue, id, "", fmt.Sprintf(`{"id":%q}`, id))
			fixture.deadLetterOne(t, entity, id, "")
		}
		fixture.waitForCounts(t, entity, 0, 2)

		result := fixture.mustCallWorker(t, "moveMessages", map[string]any{
			"sourceQueue": queue,
			"destQueue":   queue,
			"mode":        "dlq",
			"env":         fixture.workerEnv(),
		})
		if got := integrationInt(t, result, "totalMoved"); got != len(originalIDs) {
			t.Fatalf("totalMoved = %d, want %d", got, len(originalIDs))
		}
		fixture.waitForCounts(t, entity, 2, 0)

		messages := fixture.receiveQueueMessages(t, queue, "", len(originalIDs))
		seenIDs := map[string]struct{}{}
		seenOriginals := map[string]struct{}{}
		for _, message := range messages {
			if message.MessageID == "" {
				t.Fatal("replayed message has an empty MessageId")
			}
			for _, originalID := range originalIDs {
				if message.MessageID == originalID {
					t.Fatalf("duplicate-detection replay reused original MessageId %q", originalID)
				}
			}
			if _, exists := seenIDs[message.MessageID]; exists {
				t.Fatalf("duplicate-detection replay generated duplicate MessageId %q", message.MessageID)
			}
			seenIDs[message.MessageID] = struct{}{}
			original, ok := message.ApplicationProperties["BusmanOriginalMessageId"].(string)
			if !ok || original == "" {
				t.Fatalf("message %q did not preserve BusmanOriginalMessageId", message.MessageID)
			}
			seenOriginals[original] = struct{}{}
		}
		for _, originalID := range originalIDs {
			if _, ok := seenOriginals[originalID]; !ok {
				t.Errorf("replay did not preserve original MessageId %q", originalID)
			}
		}
	})

	t.Run("bulk move preserves broker affinity", func(t *testing.T) {
		t.Run("mixed partition keys", func(t *testing.T) {
			fixture := newAzureIntegrationFixture(t, config)
			enablePartitioning := true
			source := fixture.createQueue(t, "partition-source", &admin.QueueProperties{
				EnablePartitioning: &enablePartitioning,
			}, "partitioned queues")
			destination := fixture.createQueue(t, "partition-dest", &admin.QueueProperties{
				EnablePartitioning: &enablePartitioning,
			}, "partitioned queues")

			messages := []azureIntegrationMessage{
				{id: "partition-a-1", body: "a1", partitionKey: "partition-a"},
				{id: "partition-b-1", body: "b1", partitionKey: "partition-b"},
				{id: "partition-a-2", body: "a2", partitionKey: "partition-a"},
			}
			fixture.sendSDKMessages(t, source, messages)
			fixture.waitForCounts(t, azureIntegrationEntity{queue: source}, len(messages), 0)
			result := fixture.mustCallWorker(t, "moveMessages", map[string]any{
				"sourceQueue": source,
				"destQueue":   destination,
				"mode":        "normal",
				"env":         fixture.workerEnv(),
			})
			if got := integrationInt(t, result, "totalMoved"); got != len(messages) {
				t.Fatalf("totalMoved = %d, want %d", got, len(messages))
			}
			received := fixture.receiveQueueMessages(t, destination, "", len(messages))
			assertIntegrationAffinity(t, received, messages)
		})

		t.Run("mixed partitioned sessions", func(t *testing.T) {
			fixture := newAzureIntegrationFixture(t, config)
			enablePartitioning := true
			requiresSession := true
			source := fixture.createQueue(t, "partition-session-source", &admin.QueueProperties{
				EnablePartitioning: &enablePartitioning,
				RequiresSession:    &requiresSession,
			}, "partitioned session queues")
			destination := fixture.createQueue(t, "partition-session-dest", &admin.QueueProperties{
				EnablePartitioning: &enablePartitioning,
				RequiresSession:    &requiresSession,
			}, "partitioned session queues")

			messages := []azureIntegrationMessage{
				{id: "session-a-1", body: "a1", partitionKey: "affinity-a", sessionID: "affinity-a"},
				{id: "session-b-1", body: "b1", partitionKey: "affinity-b", sessionID: "affinity-b"},
				{id: "session-a-2", body: "a2", partitionKey: "affinity-a", sessionID: "affinity-a"},
			}
			fixture.sendSDKMessages(t, source, messages)
			fixture.waitForCounts(t, azureIntegrationEntity{queue: source}, len(messages), 0)
			result := fixture.mustCallWorker(t, "moveMessages", map[string]any{
				"sourceQueue": source,
				"destQueue":   destination,
				"mode":        "normal",
				"env":         fixture.workerEnv(),
			})
			if got := integrationInt(t, result, "totalMoved"); got != len(messages) {
				t.Fatalf("totalMoved = %d, want %d", got, len(messages))
			}
			received := append(
				fixture.receiveQueueMessages(t, destination, "affinity-a", 2),
				fixture.receiveQueueMessages(t, destination, "affinity-b", 1)...,
			)
			assertIntegrationAffinity(t, received, messages)
		})
	})
}

func loadAzureIntegrationConfig(t *testing.T) azureIntegrationConfig {
	t.Helper()
	connectionString := strings.TrimSpace(os.Getenv(azureIntegrationConnectionStringEnv))
	if connectionString == "" {
		t.Skipf("set %s to run the opt-in real-Azure integration suite", azureIntegrationConnectionStringEnv)
	}

	namespace, entityPath, err := integrationNamespaceFromConnectionString(connectionString)
	if err != nil {
		t.Fatalf("%s is not a valid namespace connection string: %s", azureIntegrationConnectionStringEnv, redactIntegrationError(err))
	}
	if entityPath != "" {
		t.Fatalf("%s must be namespace-scoped (EntityPath is not allowed)", azureIntegrationConnectionStringEnv)
	}
	if expected := strings.TrimSpace(os.Getenv(azureIntegrationExpectedNamespaceEnv)); expected != "" && !integrationNamespaceMatches(namespace, expected) {
		t.Fatalf("connected namespace %q does not match %s=%q", namespace, azureIntegrationExpectedNamespaceEnv, expected)
	}

	return azureIntegrationConfig{connectionString: connectionString, namespace: namespace}
}

func integrationNamespaceFromConnectionString(connectionString string) (string, string, error) {
	var endpoint string
	var entityPath string
	for _, part := range strings.Split(connectionString, ";") {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "endpoint":
			endpoint = strings.TrimSpace(value)
		case "entitypath":
			entityPath = strings.TrimSpace(value)
		}
	}
	if endpoint == "" {
		return "", "", fmt.Errorf("Endpoint is missing")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || !strings.EqualFold(parsed.Scheme, "sb") || parsed.Hostname() == "" {
		return "", "", fmt.Errorf("Endpoint must be an sb:// namespace URL")
	}
	return strings.ToLower(parsed.Hostname()), entityPath, nil
}

func integrationNamespaceMatches(namespace, expected string) bool {
	expected = strings.ToLower(strings.TrimSpace(expected))
	if parsed, err := url.Parse(expected); err == nil && parsed.Hostname() != "" {
		expected = parsed.Hostname()
	}
	expected = strings.TrimSuffix(strings.TrimPrefix(expected, "sb://"), "/")
	if expected == namespace {
		return true
	}
	shortNamespace, _, _ := strings.Cut(namespace, ".")
	return expected == shortNamespace
}

func newAzureIntegrationFixture(t *testing.T, config azureIntegrationConfig) *azureIntegrationFixture {
	t.Helper()
	adminClient, err := admin.NewClientFromConnectionString(config.connectionString, nil)
	if err != nil {
		t.Fatalf("create Service Bus admin client: %s", redactIntegrationError(err))
	}
	random := make([]byte, 4)
	if _, err := cryptorand.Read(random); err != nil {
		t.Fatalf("generate integration entity prefix: %v", err)
	}
	return &azureIntegrationFixture{
		t:             t,
		config:        config,
		admin:         adminClient,
		prefix:        fmt.Sprintf("busman-it-%x-%x", time.Now().UnixNano(), random),
		queues:        map[string]struct{}{},
		topics:        map[string]struct{}{},
		subscriptions: map[string]struct{}{},
	}
}

func (f *azureIntegrationFixture) entityName(t *testing.T, suffix string) string {
	t.Helper()
	if !azureIntegrationSuffixRE.MatchString(suffix) {
		t.Fatalf("unsafe integration entity suffix %q", suffix)
	}
	name := f.prefix + "-" + suffix
	if !azureIntegrationOwnedNameRE.MatchString(name) {
		t.Fatalf("generated integration entity name %q does not match the ownership guard", name)
	}
	if err := validateEntityName(name, "Integration entity"); err != nil {
		t.Fatalf("generated integration entity name is invalid: %v", err)
	}
	return name
}

func (f *azureIntegrationFixture) createQueue(t *testing.T, suffix string, properties *admin.QueueProperties, feature string) string {
	t.Helper()
	name := f.entityName(t, suffix)
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	response, err := f.admin.CreateQueue(ctx, name, &admin.CreateQueueOptions{Properties: properties})
	if err != nil {
		if isUnsupportedAzureIntegrationFeature(err) {
			t.Skipf("%s are unsupported by namespace %s: %s", feature, f.config.namespace, redactIntegrationError(err))
		}
		t.Fatalf("create integration queue %q: %s", name, redactIntegrationError(err))
	}
	f.queues[name] = struct{}{}
	t.Cleanup(func() { f.deleteQueue(name) })
	if response.QueueName != name {
		t.Fatalf("created queue name = %q, want exact name %q", response.QueueName, name)
	}
	if integrationRequestedPropertyMissing(properties.RequiresSession, response.RequiresSession) ||
		integrationRequestedPropertyMissing(properties.RequiresDuplicateDetection, response.RequiresDuplicateDetection) ||
		integrationRequestedPropertyMissing(properties.EnablePartitioning, response.EnablePartitioning) {
		t.Skipf("%s were accepted but not enabled by namespace %s", feature, f.config.namespace)
	}
	return name
}

func (f *azureIntegrationFixture) createTopic(t *testing.T, suffix string, properties *admin.TopicProperties, feature string) string {
	t.Helper()
	name := f.entityName(t, suffix)
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	response, err := f.admin.CreateTopic(ctx, name, &admin.CreateTopicOptions{Properties: properties})
	if err != nil {
		if isUnsupportedAzureIntegrationFeature(err) {
			t.Skipf("%s are unsupported by namespace %s: %s", feature, f.config.namespace, redactIntegrationError(err))
		}
		t.Fatalf("create integration topic %q: %s", name, redactIntegrationError(err))
	}
	f.topics[name] = struct{}{}
	t.Cleanup(func() { f.deleteTopic(name) })
	if response.TopicName != name {
		t.Fatalf("created topic name = %q, want exact name %q", response.TopicName, name)
	}
	return name
}

func (f *azureIntegrationFixture) createSubscription(t *testing.T, topic, suffix string, properties *admin.SubscriptionProperties, feature string) string {
	t.Helper()
	if _, owned := f.topics[topic]; !owned {
		t.Fatalf("refusing to create a subscription on unowned topic %q", topic)
	}
	name := f.entityName(t, suffix)
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	response, err := f.admin.CreateSubscription(ctx, topic, name, &admin.CreateSubscriptionOptions{Properties: properties})
	if err != nil {
		if isUnsupportedAzureIntegrationFeature(err) {
			t.Skipf("%s are unsupported by namespace %s: %s", feature, f.config.namespace, redactIntegrationError(err))
		}
		t.Fatalf("create integration subscription %q: %s", name, redactIntegrationError(err))
	}
	key := integrationSubscriptionKey(topic, name)
	f.subscriptions[key] = struct{}{}
	t.Cleanup(func() { f.deleteSubscription(topic, name) })
	if response.TopicName != topic || response.SubscriptionName != name {
		t.Fatalf("created subscription target = %q/%q, want exact target %q/%q", response.TopicName, response.SubscriptionName, topic, name)
	}
	if integrationRequestedPropertyMissing(properties.RequiresSession, response.RequiresSession) {
		t.Skipf("%s were accepted but not enabled by namespace %s", feature, f.config.namespace)
	}
	return name
}

func integrationRequestedPropertyMissing(requested, actual *bool) bool {
	return requested != nil && *requested && (actual == nil || !*actual)
}

func (f *azureIntegrationFixture) deleteQueue(name string) {
	if _, owned := f.queues[name]; !owned || !azureIntegrationOwnedNameRE.MatchString(name) || !strings.HasPrefix(name, f.prefix+"-") {
		f.t.Errorf("refusing to clean up unowned queue %q", name)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	if _, err := f.admin.DeleteQueue(ctx, name, nil); err != nil {
		f.t.Errorf("delete integration queue %q: %s", name, redactIntegrationError(err))
	}
}

func (f *azureIntegrationFixture) deleteTopic(name string) {
	if _, owned := f.topics[name]; !owned || !azureIntegrationOwnedNameRE.MatchString(name) || !strings.HasPrefix(name, f.prefix+"-") {
		f.t.Errorf("refusing to clean up unowned topic %q", name)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	if _, err := f.admin.DeleteTopic(ctx, name, nil); err != nil {
		f.t.Errorf("delete integration topic %q: %s", name, redactIntegrationError(err))
	}
}

func (f *azureIntegrationFixture) deleteSubscription(topic, subscription string) {
	key := integrationSubscriptionKey(topic, subscription)
	_, ownedTopic := f.topics[topic]
	_, ownedSubscription := f.subscriptions[key]
	if !ownedTopic || !ownedSubscription || !azureIntegrationOwnedNameRE.MatchString(topic) || !azureIntegrationOwnedNameRE.MatchString(subscription) ||
		!strings.HasPrefix(topic, f.prefix+"-") || !strings.HasPrefix(subscription, f.prefix+"-") {
		f.t.Errorf("refusing to clean up unowned subscription %q/%q", topic, subscription)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), adminTimeout)
	defer cancel()
	if _, err := f.admin.DeleteSubscription(ctx, topic, subscription, nil); err != nil {
		f.t.Errorf("delete integration subscription %q/%q: %s", topic, subscription, redactIntegrationError(err))
	}
}

func integrationSubscriptionKey(topic, subscription string) string {
	return topic + "\x00" + subscription
}

func (f *azureIntegrationFixture) workerEnv() map[string]string {
	return map[string]string{
		"SERVICE_BUS_CONNECTION_STRING": f.config.connectionString,
		"MAX_WAIT_TIME_IN_MS":           "10000",
		"DRAIN_IDLE_WAIT_TIME_IN_MS":    "1000",
		"RECEIVE_MESSAGES_COUNT":        "20",
		"COMPLETE_CONCURRENCY":          "4",
		"OPERATION_TIMEOUT_IN_MS":       "15000",
	}
}

func (f *azureIntegrationFixture) mustCallWorker(t *testing.T, method string, params any) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), azureIntegrationTimeout)
	defer cancel()
	result, err := callIntegrationWorker(ctx, method, params)
	if err != nil {
		t.Fatalf("worker method %s failed: %s", method, redactIntegrationError(err))
	}
	return result
}

func callIntegrationWorker(ctx context.Context, method string, params any) (map[string]any, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshal request parameters: %w", err)
	}
	request := Request{
		Version: protocolVersion,
		ID:      "azure-integration",
		Method:  method,
		Params:  raw,
	}
	var result any
	if handler, ok := handlers[request.Method]; ok {
		result, err = handler(request.Params)
	} else if handler, ok := cancellableHandlers[request.Method]; ok {
		result, err = handler(ctx, request.Params)
	} else {
		return nil, fmt.Errorf("worker method %q is not registered", request.Method)
	}
	if err != nil {
		return nil, err
	}

	wire, err := json.Marshal(Response{
		Version: protocolVersion,
		Type:    "response",
		ID:      request.ID,
		OK:      true,
		Result:  result,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal worker response: %w", err)
	}
	var response struct {
		Version int            `json:"version"`
		OK      bool           `json:"ok"`
		Result  map[string]any `json:"result"`
	}
	if err := json.Unmarshal(wire, &response); err != nil {
		return nil, fmt.Errorf("decode worker response: %w", err)
	}
	if response.Version != protocolVersion || !response.OK || response.Result == nil {
		return nil, fmt.Errorf("worker returned an invalid protocol response")
	}
	return response.Result, nil
}

func (f *azureIntegrationFixture) sendViaWorker(t *testing.T, entity, messageID, sessionID, body string) {
	t.Helper()
	message := map[string]any{
		"body":        body,
		"contentType": "application/json",
		"messageId":   messageID,
	}
	if sessionID != "" {
		message["sessionId"] = sessionID
	}
	result := f.mustCallWorker(t, "sendMessage", map[string]any{
		"entityName": entity,
		"env":        f.workerEnv(),
		"message":    message,
	})
	if sent, _ := result["sent"].(bool); !sent {
		t.Fatalf("sendMessage did not confirm message %q", messageID)
	}
}

func (f *azureIntegrationFixture) sendSDKMessages(t *testing.T, entity string, messages []azureIntegrationMessage) {
	t.Helper()
	client, err := azservicebus.NewClientFromConnectionString(f.config.connectionString, nil)
	if err != nil {
		t.Fatalf("create Service Bus client: %s", redactIntegrationError(err))
	}
	defer closeWithTimeout(client)
	sender, err := client.NewSender(entity, nil)
	if err != nil {
		t.Fatalf("create sender for %q: %s", entity, redactIntegrationError(err))
	}
	defer closeWithTimeout(sender)

	for _, spec := range messages {
		messageID := spec.id
		message := &azservicebus.Message{Body: []byte(spec.body), MessageID: &messageID}
		if spec.partitionKey != "" {
			partitionKey := spec.partitionKey
			message.PartitionKey = &partitionKey
		}
		if spec.sessionID != "" {
			sessionID := spec.sessionID
			message.SessionID = &sessionID
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := sender.SendMessage(ctx, message, nil)
		cancel()
		if err != nil {
			t.Fatalf("send fixture message %q: %s", spec.id, redactIntegrationError(err))
		}
	}
}

type azureIntegrationDeadLetterReceiver interface {
	ReceiveMessages(context.Context, int, *azservicebus.ReceiveMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
	DeadLetterMessage(context.Context, *azservicebus.ReceivedMessage, *azservicebus.DeadLetterOptions) error
	Close(context.Context) error
}

func (f *azureIntegrationFixture) deadLetterOne(t *testing.T, entity azureIntegrationEntity, messageID, sessionID string) {
	t.Helper()
	client, err := azservicebus.NewClientFromConnectionString(f.config.connectionString, nil)
	if err != nil {
		t.Fatalf("create Service Bus client: %s", redactIntegrationError(err))
	}
	defer closeWithTimeout(client)

	var receiver azureIntegrationDeadLetterReceiver
	if sessionID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if entity.topic != "" {
			receiver, err = client.AcceptSessionForSubscription(ctx, entity.topic, entity.subscription, sessionID, nil)
		} else {
			receiver, err = client.AcceptSessionForQueue(ctx, entity.queue, sessionID, nil)
		}
		cancel()
	} else if entity.topic != "" {
		receiver, err = client.NewReceiverForSubscription(entity.topic, entity.subscription, nil)
	} else {
		receiver, err = client.NewReceiverForQueue(entity.queue, nil)
	}
	if err != nil {
		t.Fatalf("create fixture receiver: %s", redactIntegrationError(err))
	}
	defer closeWithTimeout(receiver)

	receiveCtx, receiveCancel := context.WithTimeout(context.Background(), 30*time.Second)
	messages, receiveErr := receiver.ReceiveMessages(receiveCtx, 1, nil)
	receiveCancel()
	if receiveErr != nil && len(messages) == 0 {
		t.Fatalf("receive fixture message %q for dead-lettering: %s", messageID, redactIntegrationError(receiveErr))
	}
	if len(messages) != 1 {
		t.Fatalf("received %d messages while arranging DLQ state for %q, want 1", len(messages), messageID)
	}
	if messages[0].MessageID != messageID {
		t.Fatalf("received MessageId %q while arranging DLQ state, want %q", messages[0].MessageID, messageID)
	}
	reason := "BusmanIntegrationTest"
	description := "Created by the opt-in Busman integration suite"
	settleCtx, settleCancel := context.WithTimeout(context.Background(), 30*time.Second)
	err = receiver.DeadLetterMessage(settleCtx, messages[0], &azservicebus.DeadLetterOptions{
		Reason:           &reason,
		ErrorDescription: &description,
	})
	settleCancel()
	if err != nil {
		t.Fatalf("dead-letter fixture message %q: %s", messageID, redactIntegrationError(err))
	}
}

type azureIntegrationCompletingReceiver interface {
	ReceiveMessages(context.Context, int, *azservicebus.ReceiveMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
	CompleteMessage(context.Context, *azservicebus.ReceivedMessage, *azservicebus.CompleteMessageOptions) error
	Close(context.Context) error
}

func (f *azureIntegrationFixture) receiveQueueMessages(t *testing.T, queue, sessionID string, count int) []*azservicebus.ReceivedMessage {
	t.Helper()
	client, err := azservicebus.NewClientFromConnectionString(f.config.connectionString, nil)
	if err != nil {
		t.Fatalf("create Service Bus client: %s", redactIntegrationError(err))
	}
	defer closeWithTimeout(client)

	var receiver azureIntegrationCompletingReceiver
	if sessionID == "" {
		receiver, err = client.NewReceiverForQueue(queue, nil)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		receiver, err = client.AcceptSessionForQueue(ctx, queue, sessionID, nil)
		cancel()
	}
	if err != nil {
		t.Fatalf("create verification receiver for queue %q: %s", queue, redactIntegrationError(err))
	}
	defer closeWithTimeout(receiver)

	messages := make([]*azservicebus.ReceivedMessage, 0, count)
	deadline := time.Now().Add(30 * time.Second)
	for len(messages) < count && time.Now().Before(deadline) {
		remaining := count - len(messages)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		received, receiveErr := receiver.ReceiveMessages(ctx, remaining, nil)
		cancel()
		messages = append(messages, received...)
		if receiveErr != nil && len(received) == 0 && !strings.Contains(strings.ToLower(receiveErr.Error()), "deadline") {
			t.Fatalf("receive verification messages from queue %q: %s", queue, redactIntegrationError(receiveErr))
		}
	}
	if len(messages) != count {
		t.Fatalf("received %d messages from queue %q session %q, want %d", len(messages), queue, sessionID, count)
	}
	for _, message := range messages {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := receiver.CompleteMessage(ctx, message, nil)
		cancel()
		if err != nil {
			t.Fatalf("complete verification message %q: %s", message.MessageID, redactIntegrationError(err))
		}
	}
	return messages
}

func (f *azureIntegrationFixture) waitForCounts(t *testing.T, entity azureIntegrationEntity, wantActive, wantDLQ int) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	last := "no response"
	for time.Now().Before(deadline) {
		method := "getQueueCount"
		params := map[string]any{
			"queueName": entity.queue,
			"mode":      "both",
			"env":       f.workerEnv(),
		}
		if entity.topic != "" {
			method = "getSubscriptionCount"
			params = map[string]any{
				"topicName":        entity.topic,
				"subscriptionName": entity.subscription,
				"mode":             "both",
				"env":              f.workerEnv(),
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		result, err := callIntegrationWorker(ctx, method, params)
		cancel()
		if err == nil {
			active, activeOK := integrationNumber(result["active"])
			dlq, dlqOK := integrationNumber(result["dlq"])
			last = fmt.Sprintf("active=%d dlq=%d", active, dlq)
			if activeOK && dlqOK && active == wantActive && dlq == wantDLQ {
				return
			}
		} else {
			last = redactIntegrationError(err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("broker counts did not reach active=%d dlq=%d within 45s (last: %s)", wantActive, wantDLQ, last)
}

func (e azureIntegrationEntity) sendEntity() string {
	if e.topic != "" {
		return e.topic
	}
	return e.queue
}

func integrationMessageRecords(t *testing.T, result map[string]any) []map[string]any {
	t.Helper()
	rawMessages, ok := result["messages"].([]any)
	if !ok {
		t.Fatalf("peekMessages result has messages type %T, want []any", result["messages"])
	}
	messages := make([]map[string]any, 0, len(rawMessages))
	for _, raw := range rawMessages {
		message, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("peekMessages returned message type %T, want map[string]any", raw)
		}
		messages = append(messages, message)
	}
	return messages
}

func assertIntegrationBrowseSources(t *testing.T, messages []map[string]any, expected map[string]string) {
	t.Helper()
	found := map[string]string{}
	for _, message := range messages {
		messageID, _ := message["messageId"].(string)
		if _, wanted := expected[messageID]; !wanted {
			continue
		}
		source, _ := message["sourceSubQueue"].(string)
		found[messageID] = source
	}
	for messageID, wantSource := range expected {
		if got := found[messageID]; got != wantSource {
			t.Errorf("message %q sourceSubQueue = %q, want %q", messageID, got, wantSource)
		}
	}
}

func assertIntegrationMessageIDs(t *testing.T, messages []*azservicebus.ReceivedMessage, expected ...string) {
	t.Helper()
	found := make(map[string]struct{}, len(messages))
	for _, message := range messages {
		found[message.MessageID] = struct{}{}
	}
	for _, messageID := range expected {
		if _, ok := found[messageID]; !ok {
			t.Errorf("destination did not contain message %q", messageID)
		}
	}
}

func assertIntegrationAffinity(t *testing.T, received []*azservicebus.ReceivedMessage, expected []azureIntegrationMessage) {
	t.Helper()
	byID := make(map[string]*azservicebus.ReceivedMessage, len(received))
	for _, message := range received {
		byID[message.MessageID] = message
	}
	for _, want := range expected {
		message := byID[want.id]
		if message == nil {
			t.Errorf("destination did not contain message %q", want.id)
			continue
		}
		if got := integrationStringPointer(message.PartitionKey); got != want.partitionKey {
			t.Errorf("message %q PartitionKey = %q, want %q", want.id, got, want.partitionKey)
		}
		if got := integrationStringPointer(message.SessionID); got != want.sessionID {
			t.Errorf("message %q SessionID = %q, want %q", want.id, got, want.sessionID)
		}
	}
}

func integrationStringPointer(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func integrationInt(t *testing.T, values map[string]any, key string) int {
	t.Helper()
	value, ok := integrationNumber(values[key])
	if !ok {
		t.Fatalf("worker result field %q has type %T, want number", key, values[key])
	}
	return value
}

func integrationNumber(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		return int(number), true
	case int:
		return number, true
	case int64:
		return int(number), true
	default:
		return 0, false
	}
}

func isUnsupportedAzureIntegrationFeature(err error) bool {
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"not supported",
		"not available in",
		"basic tier",
		"requires premium",
		"premium tier is required",
		"partitioning cannot be enabled",
		"cannot be partitioned",
		"invalid combination of entity properties",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func redactIntegrationError(err error) string {
	if err == nil {
		return ""
	}
	return azureIntegrationSecretRE.ReplaceAllString(err.Error(), "$1=<redacted>")
}
