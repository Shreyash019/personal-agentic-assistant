package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"core-go/internal/agent"
	"core-go/internal/llm"
)

// ── Request types (shared/api/chat_request.json) ──────────────────────────────

// apiMessage is one entry in the incoming ChatRequest messages array.
// Mirrors the schema: { "role": "user"|"assistant"|"system"|"tool", "content": "..." }
type apiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// chatRequest is the strict JSON body accepted by POST /api/v1/chat.
// Matches shared/api/chat_request.json exactly — no flat "query" field.
// UserID is the device-generated UUID of the requesting user; it scopes
// RAG retrieval and task creation. Defaults to "default" when omitted.
type chatRequest struct {
	Messages  []apiMessage `json:"messages"`
	Stream    bool         `json:"stream"`
	UserID    string       `json:"user_id"`
	ForceTask bool         `json:"force_task"`
}

func previewPrompt(text string) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) <= 120 {
		return trimmed
	}
	return trimmed[:120] + "..."
}

// ── Handler ───────────────────────────────────────────────────────────────────

// chatHandler returns an http.HandlerFunc that:
//  1. Parses the ChatRequest body (messages array + stream flag).
//  2. Extracts the user prompt from the last message in the array.
//  3. Upgrades the response to a Server-Sent Events stream.
//  4. Routes to either the RAG or Agent pipeline.
//
// Dependencies are closed over so the handler is a plain http.HandlerFunc
// with no global state.
func chatHandler(kb *agent.KnowledgeBase, ta *agent.TaskAgent) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {

		// ── 1. Parse and validate request ─────────────────────────────────
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB cap

		var req chatRequest
		if err := decodeJSONStrict(r, &req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if len(req.Messages) == 0 {
			http.Error(w, `"messages" must be a non-empty array`, http.StatusBadRequest)
			return
		}

		// Extract the user prompt from the last message in the conversation.
		// Multi-turn history is carried by the client; the backend treats the
		// final entry as the active user turn.
		lastMsg := req.Messages[len(req.Messages)-1]
		userPrompt := strings.TrimSpace(lastMsg.Content)
		if userPrompt == "" {
			http.Error(w, "last message content must not be empty", http.StatusBadRequest)
			return
		}

		// Default userID so clients that haven't updated still work.
		userID := normalizeUserID(req.UserID, "default")
		if !isValidUserID(userID) {
			http.Error(w, "invalid user_id", http.StatusBadRequest)
			return
		}

		log.Printf("chat: user_id=%s force_task=%t stream=%t prompt_len=%d prompt_preview=%q",
			userID,
			req.ForceTask,
			req.Stream,
			len(userPrompt),
			previewPrompt(userPrompt),
		)

		// ── 2. Assert http.Flusher before committing SSE headers ──────────
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported by this server", http.StatusInternalServerError)
			return
		}

		// ── 3. Commit SSE headers ──────────────────────────────────────────
		// Nothing has been written to the body yet, so the status code is
		// still configurable. After this point all errors are SSE error events.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // prevents nginx from buffering

		// ── 4. Route ───────────────────────────────────────────────────────
		// Knowledge-bound default policy:
		//   - explicit task mode (`force_task: true`)             → Agent pipeline
		//   - explicit RAG context system prompt (legacy support) → RAG pipeline
		//   - otherwise                                            → RAG first,
		//     which internally emits an out-of-scope response when
		//     query topic is not covered by indexed knowledge.
		if hasRAGContext(req.Messages) {
			log.Printf("chat: route=rag user_id=%s reason=system_context", userID)
			streamRAG(w, flusher, r, kb, userPrompt, userID)
			return
		}

		if agent.ShouldUseTaskAgent(userPrompt, req.ForceTask) {
			reason := "task_intent"
			if req.ForceTask {
				reason = "force_task"
			}
			log.Printf("chat: route=agent user_id=%s reason=%s", userID, reason)
			streamAgent(w, flusher, r, ta, userPrompt, userID, req.ForceTask)
			return
		}

		log.Printf("chat: route=rag user_id=%s reason=default", userID)
		streamRAG(w, flusher, r, kb, userPrompt, userID)
	}
}

// hasRAGContext returns true when the message history contains a system
// message whose content signals knowledge-base retrieval mode.
// This keeps routing implicit in the conversation rather than a separate field.
func hasRAGContext(messages []apiMessage) bool {
	for _, m := range messages {
		if m.Role == "system" {
			lc := strings.ToLower(m.Content)
			if strings.Contains(lc, "knowledge") || strings.Contains(lc, "rag") {
				return true
			}
		}
	}
	return false
}

// ── RAG pipeline ──────────────────────────────────────────────────────────────

// streamRAG runs AskKnowledgeBase and writes each text chunk as an SSE
// "message" event. userID scopes retrieval to admin + user documents.
func streamRAG(w http.ResponseWriter, f http.Flusher, r *http.Request, kb *agent.KnowledgeBase, query, userID string) {
	ch, err := kb.AskKnowledgeBase(r.Context(), query, userID)
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
// userID is forwarded so created tasks are scoped to the requesting user.
func streamAgent(w http.ResponseWriter, f http.Flusher, r *http.Request, ta *agent.TaskAgent, query, userID string, forceTask bool) {
	ch, err := ta.HandleAgentTask(r.Context(), query, userID, forceTask)
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
			// UI uses this to show a loading / executing state.
			writeSSEEvent(w, f, "tool_call", map[string]any{
				"tool":   event.Tool,
				"status": "executing",
				"args":   event.Args,
			})

		case agent.EventToolDone:
			// task_id serialised as a string per shared/api/sse_payloads.json.
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
// Used only for pipeline startup failures before any other events are written.
func writeSSEError(w http.ResponseWriter, f http.Flusher, msg string) {
	writeSSEEvent(w, f, "error", map[string]string{"error": msg})
}
