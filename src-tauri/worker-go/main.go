package main

import (
	"bufio"
	"encoding/json"
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
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type Response struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type Event struct {
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
	writeLine(Response{Type: "response", ID: id, OK: true, Result: result})
}

func sendError(id string, msg string) {
	writeLine(Response{Type: "response", ID: id, OK: false, Error: msg})
}

func emitOutput(runID, line string, isStderr bool, elapsedMs int64) {
	if runID == "" {
		return
	}
	writeLine(Event{Type: "event", RunID: runID, Kind: "output", Line: line, IsStderr: isStderr, ElapsedMs: elapsedMs})
}

func emitProgress(runID, text string, elapsedMs int64) {
	if runID == "" {
		return
	}
	writeLine(Event{Type: "event", RunID: runID, Kind: "progress", Text: text, ElapsedMs: elapsedMs})
}

func emitSearchMatch(runID string, match any, elapsedMs int64) {
	if runID == "" {
		return
	}
	writeLine(Event{Type: "event", RunID: runID, Kind: "searchMatch", Match: match, ElapsedMs: elapsedMs})
}

func elapsedSince(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

type handlerFn func(params json.RawMessage) (any, error)

var handlers = map[string]handlerFn{
	"health":              handleHealth,
	"listEntities":        handleListEntities,
	"getEntityCounts":     handleGetEntityCounts,
	"emptyMessages":       handleEmptyMessages,
	"moveMessages":        handleMoveMessages,
	"searchMessages":      handleSearchMessages,
	"peekMessages":        handlePeekMessages,
	"sendMessage":         handleSendMessage,
	"createQueue":         handleCreateQueue,
	"createTopic":         handleCreateTopic,
	"createSubscription":  handleCreateSubscription,
	"deleteQueue":         handleDeleteQueue,
	"deleteTopic":         handleDeleteTopic,
	"deleteSubscription":  handleDeleteSubscription,
}

func handleHealth(_ json.RawMessage) (any, error) {
	return map[string]string{
		"status":  "ok",
		"runtime": runtime.Version(),
	}, nil
}

func dispatch(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}

	var req Request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		writeLine(Response{Type: "response", ID: "", OK: false, Error: "Invalid JSON request."})
		return
	}

	if req.ID == "" || req.Method == "" {
		writeLine(Response{Type: "response", ID: req.ID, OK: false, Error: "Invalid request format."})
		return
	}

	handler, ok := handlers[req.Method]
	if !ok {
		sendError(req.ID, fmt.Sprintf("Unknown worker method: %s", req.Method))
		return
	}

	result, err := handler(req.Params)
	if err != nil {
		sendError(req.ID, err.Error())
		return
	}
	sendResponse(req.ID, result)
}

// ─── Entry point ─────────────────────────────────────────────────────────────

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// 10 MB line buffer — enough for very large message bodies.
	scanner.Buffer(make([]byte, 10*1024*1024), 10*1024*1024)
	for scanner.Scan() {
		dispatch(scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stdin read error: %v\n", err)
		os.Exit(1)
	}
}
