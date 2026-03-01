package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

const (
	ollamaChatURL = "http://localhost:11434/api/chat"
	chatModel     = "llama3.1:8b"
)

// streamClient has no Timeout so streaming responses are not killed mid-stream.
// Cancellation is handled entirely by the caller's context.
var streamClient = &http.Client{}

// --- Public types ---

// Message is one entry in the conversation history sent to Ollama.
// ToolCalls is only populated when reconstructing an assistant turn that
// contained tool invocations (needed for the second-turn follow-up).
type Message struct {
	Role      string          `json:"role"`
	Content   string          `json:"content"`
	ToolCalls json.RawMessage `json:"tool_calls,omitempty"`
}

// Tool is an Ollama-compatible function tool definition.
type Tool struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

// ToolFunction holds the schema for a single callable function.
type ToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// ChunkKind discriminates the two variants a stream can produce.
type ChunkKind int

const (
	KindText     ChunkKind = iota // model is writing prose
	KindToolCall                  // model decided to call a tool
)

// ToolCall carries a parsed tool invocation returned by the model.
// Arguments is kept as raw JSON so callers unmarshal into their own structs.
type ToolCall struct {
	Name      string
	Arguments json.RawMessage
}

// Chunk is one emission from the StreamChat channel.
// Inspect Kind before reading Text or ToolCall.
type Chunk struct {
	Kind     ChunkKind
	Text     string    // set when Kind == KindText
	ToolCall *ToolCall // set when Kind == KindToolCall
}

// CreateTaskTool is the Ollama tool schema for the create_task function.
// Matches shared/tools/create_task.json exactly: priority is a string enum,
// NOT an integer. Pass this (or a slice containing it) to StreamChat.
var CreateTaskTool = Tool{
	Type: "function",
	Function: ToolFunction{
		Name:        "create_task",
		Description: "Creates a new actionable task in the local Postgres database based on the user's request. Use this when the user explicitly asks to remember something, set a reminder, or create a to-do item.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"title":       {"type": "string", "description": "A concise, actionable title for the task (max 50 characters)."},
				"description": {"type": "string", "description": "Detailed context or steps required to complete the task. Leave empty if not provided."},
				"priority":    {"type": "string", "enum": ["low", "medium", "high"], "description": "The urgency of the task. Default to 'medium' unless the user implies urgency."}
			},
			"required": ["title", "priority"]
		}`),
	},
}

// --- Internal Ollama wire types ---

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Tools    []Tool    `json:"tools,omitempty"`
	Stream   bool      `json:"stream"`
}

type ollamaMessage struct {
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls []ollamaToolCall `json:"tool_calls,omitempty"`
}

type ollamaToolCall struct {
	Function ollamaFunction `json:"function"`
}

type ollamaFunction struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"` // object, not a string
}

type ollamaChunk struct {
	Message ollamaMessage `json:"message"`
	Done    bool          `json:"done"`
}

// --- Public API ---

// StreamChat opens a streaming /api/chat request to the local Ollama instance.
// It returns a read-only Chunk channel and an error for immediate failures
// (JSON encoding, network dial). The channel is closed when the stream ends
// or ctx is cancelled; the caller does not need to close it.
//
// Timeout behaviour:
//   - ctx cancellation / deadline is the primary mechanism — pass a context
//     with a deadline from the HTTP handler to bound the full stream.
//   - streamClient has no hard Timeout so long streams are not killed.
func StreamChat(ctx context.Context, messages []Message, tools []Tool) (<-chan Chunk, error) {
	body, err := json.Marshal(chatRequest{
		Model:    chatModel,
		Messages: messages,
		Tools:    tools,
		Stream:   true,
	})
	if err != nil {
		return nil, fmt.Errorf("chat: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ollamaChatURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("chat: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := streamClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chat: http: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("chat: ollama status %d", resp.StatusCode)
	}

	ch := make(chan Chunk, 16)

	go func() {
		defer close(ch)
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}

			var frame ollamaChunk
			if err := json.Unmarshal([]byte(line), &frame); err != nil {
				continue // skip malformed line, keep reading
			}

			// Tool call: one or more calls arrive before the final done=true frame.
			for _, tc := range frame.Message.ToolCalls {
				select {
				case ch <- Chunk{
					Kind: KindToolCall,
					ToolCall: &ToolCall{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				}:
				case <-ctx.Done():
					return
				}
			}

			// Text chunk: non-empty content on done=false frames.
			if content := frame.Message.Content; content != "" {
				select {
				case ch <- Chunk{Kind: KindText, Text: content}:
				case <-ctx.Done():
					return
				}
			}

			if frame.Done {
				return
			}
		}
	}()

	return ch, nil
}
