package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/go-amqp"
)

func isSessionRequiredForBrowse(err error) bool {
	var linkError *amqp.Error
	return errors.As(err, &linkError) &&
		linkError.Condition == amqp.ErrCondNotAllowed &&
		strings.Contains(strings.ToLower(linkError.Description), "requires sessions")
}

// The Go SDK opens a receive link before peeking. The management request
// can peek across all sessions without attaching a data receiver or locking a session.
type managementPeekReceiver struct {
	connectionString string
	entityPath       string
	conn             *amqp.Conn
	link             *browseManagementLink
}

func (r *managementPeekReceiver) PeekMessages(
	ctx context.Context,
	count int,
	options *azservicebus.PeekMessagesOptions,
) ([]*azservicebus.ReceivedMessage, error) {
	if r.link == nil {
		if err := r.open(ctx); err != nil {
			return nil, err
		}
	}

	from := int64(1)
	if options != nil && options.FromSequenceNumber != nil {
		from = *options.FromSequenceNumber
	}
	reply, status, err := r.link.request(ctx, &amqp.Message{
		ApplicationProperties: map[string]any{"operation": "com.microsoft:peek-message"},
		Value: map[string]any{
			"from-sequence-number": from,
			"message-count":        int32(count),
		},
	})
	if err != nil {
		return nil, err
	}
	switch status {
	case 204:
		return nil, nil
	case 200:
		return decodeManagementPeek(reply.Value)
	case 404:
		switch reply.ApplicationProperties["error-condition"] {
		case "com.microsoft:message-not-found", amqp.Symbol("com.microsoft:message-not-found"):
			return nil, nil
		}
	}
	description, _ := reply.ApplicationProperties["status-description"].(string)
	if description == "" {
		description, _ = reply.ApplicationProperties["statusDescription"].(string)
	}
	return nil, fmt.Errorf("Service Bus management peek returned status %d: %s", status, description)
}

func (r *managementPeekReceiver) open(ctx context.Context) error {
	// The SDK already validated this connection string on the standard path.
	fields := make(map[string]string)
	for _, part := range strings.Split(r.connectionString, ";") {
		key, value, ok := strings.Cut(part, "=")
		if ok {
			fields[strings.ToLower(key)] = value
		}
	}
	endpoint, err := url.Parse(fields["endpoint"])
	if err != nil || endpoint.Host == "" {
		return errors.New("invalid Service Bus endpoint")
	}
	scheme := "amqps"
	if emulator, _ := strconv.ParseBool(fields["usedevelopmentemulator"]); emulator {
		scheme = "amqp"
	}
	address := scheme + "://" + endpoint.Host + "/"
	r.conn, err = amqp.Dial(ctx, address, &amqp.ConnOptions{
		HostName:     endpoint.Host,
		SASLType:     amqp.SASLTypeAnonymous(),
		WriteTimeout: 5 * time.Second,
	})
	if err != nil {
		return err
	}
	cbsSession, err := r.conn.NewSession(ctx, nil)
	if err != nil {
		return err
	}
	defer closeWithTimeout(cbsSession)
	cbs, err := newBrowseManagementLink(ctx, cbsSession, "$cbs")
	if err != nil {
		return err
	}

	audience := address + r.entityPath
	token, expiry := browseSASToken(fields, audience)
	_, status, err := cbs.request(ctx, &amqp.Message{
		ApplicationProperties: map[string]any{
			"operation":  "put-token",
			"type":       "servicebus.windows.net:sastoken",
			"name":       audience,
			"expiration": expiry,
		},
		Value: token,
	})
	if err != nil {
		return err
	}
	if status != 200 && status != 202 {
		return fmt.Errorf("Service Bus management authorization returned status %d", status)
	}

	managementSession, err := r.conn.NewSession(ctx, nil)
	if err != nil {
		return err
	}
	r.link, err = newBrowseManagementLink(ctx, managementSession, r.entityPath+"/$management")
	return err
}

func (r *managementPeekReceiver) close() {
	if r.conn != nil {
		_ = r.conn.Close()
	}
}

func browseSASToken(fields map[string]string, audience string) (token, expiry string) {
	if token := fields["sharedaccesssignature"]; token != "" {
		return token, "0"
	}
	expiry = strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	resource := strings.ToLower(url.QueryEscape(audience))
	mac := hmac.New(sha256.New, []byte(fields["sharedaccesskey"]))
	_, _ = mac.Write([]byte(resource + "\n" + expiry))
	signature := url.QueryEscape(base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	return fmt.Sprintf("SharedAccessSignature sr=%s&sig=%s&se=%s&skn=%s",
		resource, signature, expiry, fields["sharedaccesskeyname"]), expiry
}

type browseManagementLink struct {
	sender   *amqp.Sender
	receiver *amqp.Receiver
	replyTo  string
}

func newBrowseManagementLink(ctx context.Context, session *amqp.Session, address string) (*browseManagementLink, error) {
	sender, err := session.NewSender(ctx, address, nil)
	if err != nil {
		return nil, err
	}
	replyTo := strings.ReplaceAll(address, "$", "") + "-reply-to-" + rand.Text()
	receiver, err := session.NewReceiver(ctx, address, &amqp.ReceiverOptions{
		TargetAddress:             replyTo,
		Credit:                    1,
		SettlementMode:            amqp.ReceiverSettleModeFirst.Ptr(),
		RequestedSenderSettleMode: amqp.SenderSettleModeSettled.Ptr(),
	})
	if err != nil {
		return nil, err
	}
	return &browseManagementLink{sender: sender, receiver: receiver, replyTo: replyTo}, nil
}

func (l *browseManagementLink) request(ctx context.Context, message *amqp.Message) (*amqp.Message, int32, error) {
	messageID := rand.Text()
	message.Properties = &amqp.MessageProperties{MessageID: messageID, ReplyTo: &l.replyTo}
	if deadline, ok := ctx.Deadline(); ok {
		message.ApplicationProperties["server-timeout"] = uint32(max(0, min(math.MaxUint32, time.Until(deadline)/time.Millisecond)))
	}
	if err := l.sender.Send(ctx, message, nil); err != nil {
		return nil, 0, err
	}
	reply, err := l.receiver.Receive(ctx, nil)
	if err != nil {
		return nil, 0, err
	}
	if reply.Properties == nil || reply.Properties.CorrelationID != messageID {
		return nil, 0, errors.New("Service Bus management reply did not match the request")
	}
	status, ok := reply.ApplicationProperties["status-code"].(int32)
	if !ok {
		status, ok = reply.ApplicationProperties["statusCode"].(int32)
	}
	if !ok {
		return nil, 0, errors.New("Service Bus management reply was missing a status code")
	}
	return reply, status, nil
}

func decodeManagementPeek(value any) ([]*azservicebus.ReceivedMessage, error) {
	body, _ := value.(map[string]any)
	entries, ok := body["messages"].([]any)
	if !ok {
		return nil, errors.New("Service Bus management peek reply was missing a message list")
	}
	messages := make([]*azservicebus.ReceivedMessage, 0, len(entries))
	for _, entry := range entries {
		fields, _ := entry.(map[string]any)
		data, ok := fields["message"].([]byte)
		if !ok {
			return nil, errors.New("Service Bus management peek reply contained an invalid message")
		}
		var raw amqp.Message
		if err := raw.UnmarshalBinary(data); err != nil {
			return nil, fmt.Errorf("decode peeked AMQP message: %w", err)
		}
		messages = append(messages, browseReceivedMessage(&raw))
	}
	return messages, nil
}

// Keep the same Browse fields as the SDK so both transports share paging and serialization.
func browseReceivedMessage(raw *amqp.Message) *azservicebus.ReceivedMessage {
	msg := &azservicebus.ReceivedMessage{
		ApplicationProperties:      raw.ApplicationProperties,
		SequenceNumber:             browseProperty[int64](raw.Annotations["x-opt-sequence-number"]),
		PartitionKey:               browseProperty[string](raw.Annotations["x-opt-partition-key"]),
		EnqueuedTime:               browseProperty[time.Time](raw.Annotations["x-opt-enqueued-time"]),
		LockedUntil:                browseProperty[time.Time](raw.Annotations["x-opt-locked-until"]),
		DeadLetterReason:           browseProperty[string](raw.ApplicationProperties["DeadLetterReason"]),
		DeadLetterErrorDescription: browseProperty[string](raw.ApplicationProperties["DeadLetterErrorDescription"]),
	}
	switch raw.Annotations["x-opt-message-state"] {
	case int32(1), int64(1):
		msg.State = azservicebus.MessageStateDeferred
	case int32(2), int64(2):
		msg.State = azservicebus.MessageStateScheduled
	}
	if len(raw.Data) == 1 {
		msg.Body = raw.Data[0]
	}
	if properties := raw.Properties; properties != nil {
		msg.MessageID, _ = properties.MessageID.(string)
		msg.SessionID = properties.GroupID
		msg.CorrelationID = browseProperty[string](properties.CorrelationID)
		msg.Subject = properties.Subject
		msg.ContentType = properties.ContentType
	}
	if raw.Header != nil {
		msg.DeliveryCount = raw.Header.DeliveryCount + 1
		if msg.EnqueuedTime != nil {
			expiresAt := msg.EnqueuedTime.Add(raw.Header.TTL)
			msg.ExpiresAt = &expiresAt
		}
	}
	return msg
}

func browseProperty[T any](value any) *T {
	if property, ok := value.(T); ok {
		return &property
	}
	return nil
}
