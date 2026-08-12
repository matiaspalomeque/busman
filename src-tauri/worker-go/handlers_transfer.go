package main

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

// ─── Shared outbound transfer policy and batching ──────────────────────────

func cloneApplicationProperties(props map[string]any) map[string]any {
	if len(props) == 0 {
		return nil
	}
	out := make(map[string]any, len(props))
	for k, v := range props {
		out[k] = v
	}
	return out
}

var busmanMessageIDSequence atomic.Uint64

func uniqueBusmanMessageID(original string) string {
	suffix := fmt.Sprintf("busman-%d-%d", time.Now().UnixNano(), busmanMessageIDSequence.Add(1))
	if original == "" {
		return suffix
	}
	const maxServiceBusMessageIDLength = 128
	maxOriginalLen := maxServiceBusMessageIDLength - len(suffix) - 1
	if maxOriginalLen <= 0 {
		return suffix
	}
	if len(original) > maxOriginalLen {
		original = original[:maxOriginalLen]
	}
	return original + "-" + suffix
}

func outboundMessageFromReceived(target *azservicebus.ReceivedMessage, regenerateMessageID bool) *azservicebus.Message {
	appProps := cloneApplicationProperties(target.ApplicationProperties)
	newMsg := &azservicebus.Message{
		Body:                  target.Body,
		ContentType:           target.ContentType,
		CorrelationID:         target.CorrelationID,
		Subject:               target.Subject,
		PartitionKey:          target.PartitionKey,
		ApplicationProperties: appProps,
		To:                    target.To,
		ReplyTo:               target.ReplyTo,
		ReplyToSessionID:      target.ReplyToSessionID,
		SessionID:             target.SessionID,
		TimeToLive:            target.TimeToLive,
	}
	if regenerateMessageID {
		if target.MessageID != "" {
			if newMsg.ApplicationProperties == nil {
				newMsg.ApplicationProperties = map[string]any{}
			}
			newMsg.ApplicationProperties["BusmanOriginalMessageId"] = target.MessageID
		}
		idCopy := uniqueBusmanMessageID(target.MessageID)
		newMsg.MessageID = &idCopy
		return newMsg
	}
	if target.MessageID == "" {
		return newMsg
	}
	idCopy := target.MessageID
	newMsg.MessageID = &idCopy
	return newMsg
}

type outboundMessageBatch interface {
	AddMessage(*azservicebus.Message, *azservicebus.AddMessageOptions) error
	NumMessages() int32
}

type messageBatchAffinityKind uint8

const (
	messageBatchAffinityNone messageBatchAffinityKind = iota
	messageBatchAffinityPartition
	messageBatchAffinitySession
	messageBatchAffinityMessageID
)

type messageBatchAffinity struct {
	Kind     messageBatchAffinityKind
	Value    string
	HasValue bool
}

func affinityForMessage(msg *azservicebus.Message, sourceMessageID string, policy destinationSendPolicy) (messageBatchAffinity, error) {
	if msg.SessionID != nil {
		if msg.PartitionKey != nil && *msg.PartitionKey != *msg.SessionID {
			return messageBatchAffinity{}, fmt.Errorf(
				"message %q has SessionId %q and incompatible PartitionKey %q",
				sourceMessageID,
				*msg.SessionID,
				*msg.PartitionKey,
			)
		}
		return messageBatchAffinity{
			Kind:     messageBatchAffinitySession,
			Value:    *msg.SessionID,
			HasValue: true,
		}, nil
	}
	if policy.RequiresSession {
		return messageBatchAffinity{}, fmt.Errorf("message %q has no SessionId but the destination requires sessions", sourceMessageID)
	}
	if policy.EnablePartitioning {
		if msg.PartitionKey != nil {
			return messageBatchAffinity{
				Kind:     messageBatchAffinityPartition,
				Value:    *msg.PartitionKey,
				HasValue: true,
			}, nil
		}
		if policy.RequiresDuplicateDetection {
			if msg.MessageID == nil || *msg.MessageID == "" {
				return messageBatchAffinity{}, fmt.Errorf("message %q has no MessageId for duplicate-detection partition affinity", sourceMessageID)
			}
			return messageBatchAffinity{
				Kind:     messageBatchAffinityMessageID,
				Value:    *msg.MessageID,
				HasValue: true,
			}, nil
		}
		return messageBatchAffinity{Kind: messageBatchAffinityPartition}, nil
	}
	return messageBatchAffinity{Kind: messageBatchAffinityNone}, nil
}

func sendMessagesInCompatibleBatches[B outboundMessageBatch](
	messages []*azservicebus.ReceivedMessage,
	policy destinationSendPolicy,
	newBatch func() (B, error),
	sendAndComplete func(B, []*azservicebus.ReceivedMessage) (int, error),
) (int, error) {
	if len(messages) == 0 {
		return 0, nil
	}

	type preparedMessage struct {
		source   *azservicebus.ReceivedMessage
		outbound *azservicebus.Message
		affinity messageBatchAffinity
	}
	prepared := make([]preparedMessage, len(messages))
	for i, msg := range messages {
		outbound := outboundMessageFromReceived(msg, policy.RequiresDuplicateDetection)
		affinity, err := affinityForMessage(outbound, msg.MessageID, policy)
		if err != nil {
			return 0, err
		}
		prepared[i] = preparedMessage{source: msg, outbound: outbound, affinity: affinity}
	}

	batch, err := newBatch()
	if err != nil {
		return 0, fmt.Errorf("create message batch error: %w", err)
	}
	batchSources := make([]*azservicebus.ReceivedMessage, 0, len(messages))
	confirmedTotal := 0
	currentAffinity := prepared[0].affinity

	flush := func() error {
		if len(batchSources) == 0 {
			return nil
		}
		confirmed, err := sendAndComplete(batch, batchSources)
		confirmedTotal += confirmed
		if err != nil {
			return err
		}
		batchSources = batchSources[:0]
		return nil
	}
	resetBatch := func() error {
		batch, err = newBatch()
		if err != nil {
			return fmt.Errorf("create message batch error: %w", err)
		}
		return nil
	}

	for _, msg := range prepared {
		affinity := msg.affinity
		if len(batchSources) > 0 && affinity != currentAffinity {
			if err := flush(); err != nil {
				return confirmedTotal, err
			}
			if err := resetBatch(); err != nil {
				return confirmedTotal, err
			}
		}
		currentAffinity = affinity

		addErr := batch.AddMessage(msg.outbound, nil)
		if errors.Is(addErr, azservicebus.ErrMessageTooLarge) && batch.NumMessages() > 0 {
			if err := flush(); err != nil {
				return confirmedTotal, err
			}
			if err := resetBatch(); err != nil {
				return confirmedTotal, err
			}
			addErr = batch.AddMessage(msg.outbound, nil)
		}
		if addErr != nil {
			if errors.Is(addErr, azservicebus.ErrMessageTooLarge) {
				return confirmedTotal, fmt.Errorf("send message error: message %q is too large for Service Bus batch", msg.source.MessageID)
			}
			return confirmedTotal, fmt.Errorf("add message to batch error: %w", addErr)
		}
		batchSources = append(batchSources, msg.source)
	}

	if err := flush(); err != nil {
		return confirmedTotal, err
	}
	return confirmedTotal, nil
}

type duplicateDetectionAdmin interface {
	GetQueue(context.Context, string, *admin.GetQueueOptions) (*admin.GetQueueResponse, error)
	GetTopic(context.Context, string, *admin.GetTopicOptions) (*admin.GetTopicResponse, error)
}

type destinationSendPolicy struct {
	RequiresDuplicateDetection bool
	EnablePartitioning         bool
	RequiresSession            bool
}

func destinationPolicy(
	ctx context.Context,
	adminClient duplicateDetectionAdmin,
	destination messageDestination,
) (destinationSendPolicy, error) {
	switch destination.Kind {
	case messageDestinationQueue:
		resp, err := adminClient.GetQueue(ctx, destination.Name, nil)
		if err != nil {
			return destinationSendPolicy{}, fmt.Errorf("get queue %q send configuration: %w", destination.Name, err)
		}
		if resp == nil {
			return destinationSendPolicy{}, fmt.Errorf("destination queue %q was not found", destination.Name)
		}
		return destinationSendPolicy{
			RequiresDuplicateDetection: resp.RequiresDuplicateDetection != nil && *resp.RequiresDuplicateDetection,
			EnablePartitioning:         resp.EnablePartitioning != nil && *resp.EnablePartitioning,
			RequiresSession:            resp.RequiresSession != nil && *resp.RequiresSession,
		}, nil
	case messageDestinationTopic:
		resp, err := adminClient.GetTopic(ctx, destination.Name, nil)
		if err != nil {
			return destinationSendPolicy{}, fmt.Errorf("get topic %q send configuration: %w", destination.Name, err)
		}
		if resp == nil {
			return destinationSendPolicy{}, fmt.Errorf("destination topic %q was not found", destination.Name)
		}
		return destinationSendPolicy{
			RequiresDuplicateDetection: resp.RequiresDuplicateDetection != nil && *resp.RequiresDuplicateDetection,
			EnablePartitioning:         resp.EnablePartitioning != nil && *resp.EnablePartitioning,
		}, nil
	default:
		return destinationSendPolicy{}, fmt.Errorf("invalid destination kind %q", destination.Kind)
	}
}

func inspectDestinationPolicy(ctx context.Context, connectionString string, destination messageDestination) (destinationSendPolicy, error) {
	adminClient, err := getAdminClient(connectionString)
	if err != nil {
		return destinationSendPolicy{}, err
	}
	return destinationPolicy(ctx, adminClient, destination)
}
