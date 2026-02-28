package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"core-go/internal/agent"
	"core-go/internal/llm"
)

// chatRequest is the JSON body accepted by POST /api/v1/chat.
type chatRequest struct {
	Query string `json:"query"`
	// Mode selects the pipeline: "rag" (knowledge-base Q&A) or
	// "agent" (task-creation agentic loop). Defaults to "agent".
	Mode string `json:"mode"`
}

// chatHandler returns an http.HandlerFunc that:
//  1. Validates the JSON request body.
//  2. Upgrades the response to a Server-Sent Events stream.
//  3. Routes to either the RAG or Agent pipeline based on Mode.
//
// Dependencies are closed over so the handler is a plain http.HandlerFunc
// with no global state.
func chatHandler(kb *agent.KnowledgeBase, ta *agent.TaskAgent) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {

		// ── 1. Parse and validate request ────────────────────────────────────
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB cap

		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.Query) == "" {
			http.Error(w, `"query" is required`, http.StatusBadRequest)
			return
		}
		if req.Mode == "" {
			req.Mode = "agent"
		}
		if req.Mode != "rag" && req.Mode != "agent" {
			http.Error(w, `"mode" must be "rag" or "agent"`, http.StatusBadRequest)
			return
		}

		// ── 2. Assert http.Flusher before committing SSE headers ─────────────
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported by this server", http.StatusInternalServerError)
			return
		}

		// ── 3. Commit SSE headers ─────────────────────────────────────────────
		// Nothing has been written to the body yet, so status code is still
		// configurable. After this point all errors are SSE error events.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // prevents nginx from buffering the stream

		// ── 4. Route to the chosen pipeline ──────────────────────────────────
		switch req.Mode {
		case "rag":
			streamRAG(w, flusher, r, kb, req.Query)
		case "agent":
			streamAgent(w, flusher, r, ta, req.Query)
		}
	}
}

// ── RAG pipeline ─────────────────────────────────────────────────────────────

// streamRAG runs AskKnowledgeBase and writes each text chunk as an SSE
// "message" event.
func streamRAG(w http.ResponseWriter, f http.Flusher, r *http.Request, kb *agent.KnowledgeBase, query string) {
	ch, err := kb.AskKnowledgeBase(r.Context(), query)
	if err != nil {
		writeSSEError(w, f, err.Error())
		return
	}

	for chunk := range ch {
		if chunk.Kind == llm.KindText && chunk.Text != "" {
			writeSSEEvent(w, f, "message", map[string]any{
				"content": chunk.Text,
			})
		}
	}
}

// ── Agent pipeline ────────────────────────────────────────────────────────────

// streamAgent runs HandleAgentTask and maps each AgentEvent to its
// corresponding SSE event type as defined in shared/api/sse_payloads.json.
func streamAgent(w http.ResponseWriter, f http.Flusher, r *http.Request, ta *agent.TaskAgent, query string) {
	ch, err := ta.HandleAgentTask(r.Context(), query)
	if err != nil {
		writeSSEError(w, f, err.Error())
		return
	}

	for event := range ch {
		switch event.Kind {

		case agent.EventText:
			if event.Text != "" {
				writeSSEEvent(w, f, "message", map[string]any{
					"content": event.Text,
				})
			}

		case agent.EventToolCall:
			// UI uses this to show a loading/executing state.
			writeSSEEvent(w, f, "tool_call", map[string]any{
				"tool":   event.Tool,
				"status": "executing",
				"args":   event.Args,
			})

		case agent.EventToolDone:
			// task_id is sent as a string to match the shared schema
			// ("The returned UUID from Postgres" — stored as string in JSON).
			writeSSEEvent(w, f, "tool_result", map[string]any{
				"tool":    event.Tool,
				"status":  "success",
				"task_id": strconv.FormatInt(event.TaskID, 10),
			})

		case agent.EventError:
			writeSSEEvent(w, f, "tool_result", map[string]any{
				"tool":      event.Tool,
				"status":    "error",
				"error_msg": event.ErrMsg,
			})
		}
	}
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

// writeSSEEvent serialises data as JSON and writes one complete SSE frame:
//
//	event: <name>\n
//	data: <json>\n
//	\n
//
// It flushes immediately so the client receives the frame without waiting for
// the connection to close.
func writeSSEEvent(w http.ResponseWriter, f http.Flusher, event string, data any) {
	payload, err := json.Marshal(data)
	if err != nil {
		// JSON marshalling of our own structs should never fail; log and skip.
		fmt.Fprintf(w, "event: error\ndata: {\"error\":\"marshal failure\"}\n\n")
		f.Flush()
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload)
	f.Flush()
}

// writeSSEError writes a single SSE "error" event and flushes.
// Used only for pipeline startup failures that occur before any
// other events have been written.
func writeSSEError(w http.ResponseWriter, f http.Flusher, msg string) {
	writeSSEEvent(w, f, "error", map[string]string{"error": msg})
}
