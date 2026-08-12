package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

// stdout is a buffered writer; writeLine() flushes after every line to keep
// Rust's AsyncBufReadExt::lines() from blocking.
var stdout = bufio.NewWriter(os.Stdout)

// stdoutMu protects stdout from concurrent writes when goroutines emit events.
var stdoutMu sync.Mutex

// wg tracks in-flight handler goroutines so main() can wait for them before exiting.
var wg sync.WaitGroup

const protocolVersion = 1
const maxConcurrentHandlers = 8

var handlerSlots = make(chan struct{}, maxConcurrentHandlers)

type activeRun struct {
	cancel context.CancelFunc
	done   chan struct{}
}

var activeRuns = struct {
	sync.Mutex
	runs map[string]*activeRun
}{runs: make(map[string]*activeRun)}

func writeLine(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "writeLine: marshal error: %v\n", err)
		return
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	if _, err := stdout.Write(data); err != nil {
		fmt.Fprintf(os.Stderr, "writeLine: stdout write error: %v\n", err)
		os.Exit(1)
	}
	if _, err := stdout.Write([]byte{'\n'}); err != nil {
		fmt.Fprintf(os.Stderr, "writeLine: stdout write error: %v\n", err)
		os.Exit(1)
	}
	if err := stdout.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "writeLine: stdout flush error: %v\n", err)
		os.Exit(1)
	}
}

// ─── Wire types ──────────────────────────────────────────────────────────────

type Request struct {
	Version int             `json:"version"`
	ID      string          `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type Response struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Result  any    `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
}

type Event struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	RunID     string `json:"runId,omitempty"`
	Kind      string `json:"kind"`
	Line      string `json:"line,omitempty"`
	IsStderr  bool   `json:"isStderr,omitempty"`
	Text      string `json:"text,omitempty"`
	Match     any    `json:"match,omitempty"`
	ElapsedMs int64  `json:"elapsedMs"`
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

func sendResponse(id string, result any) {
	writeLine(Response{Version: protocolVersion, Type: "response", ID: id, OK: true, Result: result})
}

func sendError(id string, msg string) {
	sendErrorCode(id, "handler_error", msg)
}

func sendErrorCode(id string, code string, msg string) {
	writeLine(Response{Version: protocolVersion, Type: "response", ID: id, OK: false, Error: msg, Code: code})
}

func emitOutput(runID, line string, isStderr bool, elapsedMs int64) {
	if runID == "" {
		return
	}
	writeLine(Event{Version: protocolVersion, Type: "event", RunID: runID, Kind: "output", Line: line, IsStderr: isStderr, ElapsedMs: elapsedMs})
}

func emitProgress(runID, text string, elapsedMs int64) {
	if runID == "" {
		return
	}
	writeLine(Event{Version: protocolVersion, Type: "event", RunID: runID, Kind: "progress", Text: text, ElapsedMs: elapsedMs})
}

func emitSearchMatch(runID string, match any, elapsedMs int64) {
	if runID == "" {
		return
	}
	writeLine(Event{Version: protocolVersion, Type: "event", RunID: runID, Kind: "searchMatch", Match: match, ElapsedMs: elapsedMs})
}

func elapsedSince(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

type handlerFn func(params json.RawMessage) (any, error)
type cancellableHandlerFn func(ctx context.Context, params json.RawMessage) (any, error)

var handlers = map[string]handlerFn{
	"health":                     handleHealth,
	"listEntities":               handleListEntities,
	"getQueueCount":              handleGetQueueCount,
	"getSubscriptionCount":       handleGetSubscriptionCount,
	"getTopicSubscriptionCounts": handleGetTopicSubscriptionCounts,
	"getEntityCounts":            handleGetEntityCounts,
	"sendMessage":                handleSendMessage,
	"createQueue":                handleCreateQueue,
	"createTopic":                handleCreateTopic,
	"createSubscription":         handleCreateSubscription,
	"deleteQueue":                handleDeleteQueue,
	"deleteTopic":                handleDeleteTopic,
	"deleteSubscription":         handleDeleteSubscription,
	"getQueueProperties":         handleGetQueueProperties,
	"getTopicProperties":         handleGetTopicProperties,
	"getSubscriptionProperties":  handleGetSubscriptionProperties,
	"sessionState":               handleSessionState,
	"listSubscriptionRules":      handleListSubscriptionRules,
	"createSubscriptionRule":     handleCreateSubscriptionRule,
	"updateSubscriptionRule":     handleUpdateSubscriptionRule,
	"deleteSubscriptionRule":     handleDeleteSubscriptionRule,
}

var cancellableHandlers = map[string]cancellableHandlerFn{
	"emptyMessages":            handleEmptyMessages,
	"moveMessages":             handleMoveMessages,
	"republishSubscriptionDlq": handleRepublishSubscriptionDlq,
	"searchMessages":           handleSearchMessages,
	"peekMessages":             handlePeekMessages,
	"singleMessageAction":      handleSingleMessageAction,
}

func handleHealth(_ json.RawMessage) (any, error) {
	return map[string]string{
		"status":   "ok",
		"runtime":  runtime.Version(),
		"protocol": fmt.Sprintf("v%d", protocolVersion),
	}, nil
}

func registerRun(runID string) (context.Context, *activeRun, error) {
	if runID == "" {
		return nil, nil, fmt.Errorf("runId is required for cancellable operations")
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &activeRun{cancel: cancel, done: make(chan struct{})}
	activeRuns.Lock()
	defer activeRuns.Unlock()
	if _, exists := activeRuns.runs[runID]; exists {
		cancel()
		return nil, nil, fmt.Errorf("operation %q is already running", runID)
	}
	activeRuns.runs[runID] = run
	return ctx, run, nil
}

func finishRun(runID string, run *activeRun) {
	activeRuns.Lock()
	if activeRuns.runs[runID] == run {
		delete(activeRuns.runs, runID)
	}
	activeRuns.Unlock()
	run.cancel()
	close(run.done)
}

func cancelRun(runID string) error {
	activeRuns.Lock()
	run := activeRuns.runs[runID]
	activeRuns.Unlock()
	if run == nil {
		return fmt.Errorf("operation %q is not running", runID)
	}
	run.cancel()
	select {
	case <-run.done:
		return nil
	case <-time.After(10 * time.Second):
		return fmt.Errorf("operation %q did not stop within 10 seconds", runID)
	}
}

func runIDFromParams(raw json.RawMessage) string {
	var params struct {
		RunID string `json:"runId"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return ""
	}
	return params.RunID
}

func dispatch(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}

	var req Request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		writeLine(Response{Version: protocolVersion, Type: "response", ID: "", OK: false, Error: "Invalid JSON request.", Code: "invalid_request"})
		return
	}

	if req.ID == "" || req.Method == "" {
		sendErrorCode(req.ID, "invalid_request", "Invalid request format.")
		return
	}
	if req.Version != protocolVersion {
		sendErrorCode(req.ID, "unsupported_protocol", fmt.Sprintf("Unsupported protocol version %d.", req.Version))
		return
	}
	if req.Method == "cancelRun" {
		runID := runIDFromParams(req.Params)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := cancelRun(runID); err != nil {
				sendErrorCode(req.ID, "cancel_failed", err.Error())
				return
			}
			sendResponse(req.ID, map[string]any{"cancelled": true, "runId": runID})
		}()
		return
	}

	handler, ok := handlers[req.Method]
	cancellableHandler, cancellable := cancellableHandlers[req.Method]
	if !ok && !cancellable {
		sendErrorCode(req.ID, "unknown_method", fmt.Sprintf("Unknown worker method: %s", req.Method))
		return
	}

	if cancellable {
		// Register before starting the goroutine so a cancel request read on the
		// next stdin line can always find this run, even if it has not acquired a
		// handler slot yet.
		runID := runIDFromParams(req.Params)
		ctx, run, err := registerRun(runID)
		if err != nil {
			sendErrorCode(req.ID, "invalid_run", err.Error())
			return
		}

		wg.Add(1)
		go func(id string, fn cancellableHandlerFn, params json.RawMessage) {
			defer wg.Done()
			defer finishRun(runID, run)
			select {
			case handlerSlots <- struct{}{}:
				defer func() { <-handlerSlots }()
			case <-ctx.Done():
				sendErrorCode(id, "cancelled", "Operation cancelled.")
				return
			}
			result, err := fn(ctx, params)
			if err != nil && errors.Is(err, context.Canceled) {
				sendErrorCode(id, "cancelled", "Operation cancelled.")
				return
			}
			if err != nil {
				sendError(id, err.Error())
				return
			}
			sendResponse(id, result)
		}(req.ID, cancellableHandler, req.Params)
		return
	}

	// Dispatch regular handlers concurrently. Each handler creates its own SDK
	// clients and stdout writes are protected by stdoutMu.
	wg.Add(1)
	go func(id string, fn handlerFn, params json.RawMessage) {
		defer wg.Done()
		handlerSlots <- struct{}{}
		defer func() { <-handlerSlots }()
		result, err := fn(params)
		if err != nil {
			sendError(id, err.Error())
			return
		}
		sendResponse(id, result)
	}(req.ID, handler, req.Params)
}

// ─── Entry point ─────────────────────────────────────────────────────────────

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// Start with 64 KB, grow up to 100 MB — aligned with the Rust-side MAX_LINE_BYTES guard.
	scanner.Buffer(make([]byte, 64*1024), 100*1024*1024)
	for scanner.Scan() {
		dispatch(scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stdin read error: %v\n", err)
	}
	// Wait for in-flight handlers to finish before exiting.
	wg.Wait()
}
