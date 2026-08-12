package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

// Base64 expands bytes by 4/3. Reserve 64 KiB of the 32 MiB worker frame for
// the JSON response envelope, request metadata, and future protocol fields.
const maxSessionStateBytes = (32 * 1024 * 1024 * 3 / 4) - (64 * 1024)

type sessionStateParams struct {
	Action      string            `json:"action"`
	QueueName   string            `json:"queueName"`
	SessionID   string            `json:"sessionId"`
	StateBase64 *string           `json:"stateBase64,omitempty"`
	Env         map[string]string `json:"env"`
	subscriptionSource
}

type sessionStateResult struct {
	Encoding    string `json:"encoding"`
	StateBase64 string `json:"stateBase64"`
	ByteLength  int    `json:"byteLength"`
	HasState    bool   `json:"hasState"`
}

type sessionStateReceiver interface {
	sessionLockReceiver
	GetSessionState(context.Context, *azservicebus.GetSessionStateOptions) ([]byte, error)
	SetSessionState(context.Context, []byte, *azservicebus.SetSessionStateOptions) error
	Close(context.Context) error
}

func (p sessionStateParams) validate() error {
	hasQueue := p.QueueName != ""
	hasTopic := p.TopicName != ""
	hasSubscription := p.SubscriptionName != ""
	if hasQueue == (hasTopic || hasSubscription) || hasTopic != hasSubscription {
		return fmt.Errorf("provide exactly one parent queue or one topic/subscription pair")
	}
	if hasQueue {
		if err := validateEntityName(p.QueueName, "Queue"); err != nil {
			return err
		}
	} else {
		if err := validateEntityName(p.TopicName, "Topic"); err != nil {
			return err
		}
		if err := validateEntityName(p.SubscriptionName, "Subscription"); err != nil {
			return err
		}
	}
	if strings.TrimSpace(p.SessionID) == "" {
		return fmt.Errorf("Session Id is required")
	}
	switch p.Action {
	case "get", "clear":
		if p.StateBase64 != nil {
			return fmt.Errorf("stateBase64 is only valid for the set action")
		}
	case "set":
		if p.StateBase64 == nil {
			return fmt.Errorf("stateBase64 is required for the set action")
		}
	default:
		return fmt.Errorf("action must be get, set, or clear")
	}
	return nil
}

func decodeSessionStateBase64(value string) ([]byte, error) {
	if len(value) > base64.StdEncoding.EncodedLen(maxSessionStateBytes) {
		return nil, fmt.Errorf("session state exceeds the %d-byte decoded payload limit", maxSessionStateBytes)
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, fmt.Errorf("session state must be canonical standard base64")
	}
	if len(decoded) > maxSessionStateBytes {
		return nil, fmt.Errorf("session state exceeds the %d-byte decoded payload limit", maxSessionStateBytes)
	}
	return decoded, nil
}

func encodeSessionStateResult(state []byte, hasState bool) (sessionStateResult, error) {
	if len(state) > maxSessionStateBytes {
		return sessionStateResult{}, fmt.Errorf(
			"stored session state is %d bytes and exceeds the %d-byte worker response policy",
			len(state),
			maxSessionStateBytes,
		)
	}
	return sessionStateResult{
		Encoding:    "base64",
		StateBase64: base64.StdEncoding.EncodeToString(state),
		ByteLength:  len(state),
		HasState:    hasState,
	}, nil
}

func runSessionStateAction(
	requestCtx context.Context,
	receiver sessionStateReceiver,
	p sessionStateParams,
	maxWaitMs int,
) (result sessionStateResult, err error) {
	renewer := startSessionLockRenewer(
		requestCtx,
		receiver,
		maxWaitMs,
		sessionLockRenewInterval(time.Now(), receiver.LockedUntil()),
	)
	defer func() {
		renewErr := renewer.stop()
		closeWithTimeout(receiver)
		if renewErr == nil || (err != nil && errors.Is(err, renewErr)) {
			return
		}
		renewErr = fmt.Errorf("renew session %q lock while managing state: %w", receiver.SessionID(), renewErr)
		if err != nil {
			err = errors.Join(err, renewErr)
			return
		}
		err = renewErr
	}()

	operationCtx, operationCancel := cancellableOperationContext(requestCtx, p.Env, maxWaitMs)
	defer operationCancel()

	switch p.Action {
	case "get":
		state, getErr := receiver.GetSessionState(operationCtx, nil)
		if getErr != nil {
			return result, fmt.Errorf("get session %q state: %w", p.SessionID, getErr)
		}
		return encodeSessionStateResult(state, state != nil)
	case "set":
		state, decodeErr := decodeSessionStateBase64(*p.StateBase64)
		if decodeErr != nil {
			return result, decodeErr
		}
		if setErr := receiver.SetSessionState(operationCtx, state, nil); setErr != nil {
			return result, fmt.Errorf("set session %q state: %w", p.SessionID, setErr)
		}
		return encodeSessionStateResult(state, true)
	case "clear":
		if clearErr := receiver.SetSessionState(operationCtx, nil, nil); clearErr != nil {
			return result, fmt.Errorf("clear session %q state: %w", p.SessionID, clearErr)
		}
		return encodeSessionStateResult(nil, false)
	default:
		return result, fmt.Errorf("unsupported session state action %q", p.Action)
	}
}

func handleSessionState(raw json.RawMessage) (any, error) {
	var p sessionStateParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	if err := p.validate(); err != nil {
		return nil, err
	}
	if p.Action == "set" {
		if _, err := decodeSessionStateBase64(*p.StateBase64); err != nil {
			return nil, err
		}
	}
	connectionString, err := requireConnectionString(p.Env)
	if err != nil {
		return nil, err
	}
	maxWaitMs := parseIntOrDefault(p.Env["MAX_WAIT_TIME_IN_MS"], 60000)
	client, err := azservicebus.NewClientFromConnectionString(connectionString, nil)
	if err != nil {
		return nil, fmt.Errorf("service bus client error: %w", err)
	}
	defer closeWithTimeout(client)

	acceptCtx, acceptCancel := context.WithTimeout(context.Background(), time.Duration(maxWaitMs)*time.Millisecond)
	var receiver *azservicebus.SessionReceiver
	if p.isSubscription() {
		receiver, err = client.AcceptSessionForSubscription(acceptCtx, p.TopicName, p.SubscriptionName, p.SessionID, nil)
	} else {
		receiver, err = client.AcceptSessionForQueue(acceptCtx, p.QueueName, p.SessionID, nil)
	}
	acceptCancel()
	if err != nil {
		return nil, fmt.Errorf("accept session %q for state management: %w", p.SessionID, err)
	}

	return runSessionStateAction(context.Background(), receiver, p, maxWaitMs)
}
