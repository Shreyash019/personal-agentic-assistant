package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"core-go/internal/db"
	"core-go/internal/llm"
)

// --- Agent event types (map 1:1 to sse_payloads.json) ---

// EventKind discriminates the four events the agentic loop can emit.
type EventKind int

const (
	EventText     EventKind = iota // prose token from the LLM
	EventToolCall                  // model requested create_task (UI shows loading)
	EventToolDone                  // task persisted successfully
	EventError                     // validation or DB failure
)

// AgentEvent is one emission from the HandleAgentTask channel.
type AgentEvent struct {
	Kind   EventKind
	Text   string         // EventText: prose token
	Tool   string         // EventToolCall / EventToolDone: tool name
	Args   map[string]any // EventToolCall: validated args (shown in UI)
	TaskID int64          // EventToolDone: Postgres-generated ID
	ErrMsg string         // EventError: human-readable message
}

// --- Schema validation ---

type createTaskArgs struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    int    `json:"priority"`
}

func validateCreateTaskArgs(raw json.RawMessage) (createTaskArgs, error) {
	var args createTaskArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return args, fmt.Errorf("unmarshal args: %w", err)
	}
	if strings.TrimSpace(args.Title) == "" {
		return args, fmt.Errorf("'title' is required and must be non-empty")
	}
	if args.Priority < 0 || args.Priority > 3 {
		return args, fmt.Errorf("'priority' must be 0–3, got %d", args.Priority)
	}
	return args, nil
}

// --- System prompt ---

const agentSystemPrompt = `You are a personal task management assistant.
When the user wants to create, add, or record a task, use the create_task tool.
Extract the task title (required), description (if mentioned), and priority
(if mentioned; 0=low 1=medium 2=high 3=urgent; default 0).
If the user's intent is not to create a task, respond conversationally without using a tool.`

// --- TaskAgent ---

// TaskAgent runs the agentic loop that detects task-creation intent,
// executes the tool, and generates a final summary for the user.
type TaskAgent struct {
	repo db.TaskRepository
}

// NewTaskAgent returns a TaskAgent backed by the given repository.
func NewTaskAgent(repo db.TaskRepository) *TaskAgent {
	return &TaskAgent{repo: repo}
}

// HandleAgentTask runs the full agentic loop for userMessage and returns a
// read-only channel of AgentEvents. The channel is closed when the loop
// completes or ctx is cancelled.
//
//  1. Sends userMessage to Ollama with the create_task tool attached.
//  2. If Ollama returns a ToolCall chunk:
//     a. Validates the extracted args (title required, priority 0–3).
//     b. Emits EventToolCall so the UI can show a loading state.
//     c. Calls TaskRepository.CreateTask.
//     d. Emits EventToolDone with the generated task ID.
//     e. Sends a tool-result confirmation back to Ollama for a final summary.
//  3. Streams all LLM text tokens as EventText.
func (ta *TaskAgent) HandleAgentTask(ctx context.Context, userMessage string) (<-chan AgentEvent, error) {
	messages := []llm.Message{
		{Role: "system", Content: agentSystemPrompt},
		{Role: "user", Content: userMessage},
	}

	ch, err := llm.StreamChat(ctx, messages, []llm.Tool{llm.CreateTaskTool})
	if err != nil {
		return nil, fmt.Errorf("agent: start stream: %w", err)
	}

	out := make(chan AgentEvent, 16)
	go ta.runLoop(ctx, ch, messages, out)
	return out, nil
}

// runLoop reads from the first-turn Chunk channel and orchestrates the
// validation → DB write → second-turn summary flow.
func (ta *TaskAgent) runLoop(
	ctx context.Context,
	ch <-chan llm.Chunk,
	firstTurnMessages []llm.Message,
	out chan<- AgentEvent,
) {
	defer close(out)

	for chunk := range ch {
		switch chunk.Kind {

		case llm.KindText:
			emit(ctx, out, AgentEvent{Kind: EventText, Text: chunk.Text})

		case llm.KindToolCall:
			tc := chunk.ToolCall

			// Step 2a — validate args against the create_task schema.
			args, err := validateCreateTaskArgs(tc.Arguments)
			if err != nil {
				emit(ctx, out, AgentEvent{
					Kind:   EventError,
					ErrMsg: fmt.Sprintf("tool arg validation: %v", err),
				})
				return
			}

			validatedArgs := map[string]any{
				"title":       args.Title,
				"description": args.Description,
				"priority":    args.Priority,
			}

			// Step 2b — emit tool_call so the UI shows a loading state.
			emit(ctx, out, AgentEvent{
				Kind: EventToolCall,
				Tool: tc.Name,
				Args: validatedArgs,
			})

			// Step 2c — execute TaskRepository.CreateTask.
			taskID, err := ta.repo.CreateTask(ctx, args.Title, args.Description, args.Priority)
			if err != nil {
				emit(ctx, out, AgentEvent{
					Kind:   EventError,
					ErrMsg: fmt.Sprintf("create task: %v", err),
				})
				return
			}

			// Step 2d — emit tool_done with the Postgres-generated ID.
			emit(ctx, out, AgentEvent{
				Kind:   EventToolDone,
				Tool:   tc.Name,
				TaskID: int64(taskID),
			})

			// Step 2e — build second-turn history and stream the final summary.
			ta.streamSummary(ctx, firstTurnMessages, tc.Name, validatedArgs, int64(taskID), out)
			return // agentic loop ends after one tool execution
		}
	}
}

// streamSummary reconstructs the full message history including the tool
// result and streams Ollama's final natural-language confirmation.
func (ta *TaskAgent) streamSummary(
	ctx context.Context,
	firstTurnMessages []llm.Message,
	toolName string,
	validatedArgs map[string]any,
	taskID int64,
	out chan<- AgentEvent,
) {
	// Reconstruct the assistant's tool-call message for Ollama's history.
	toolCallsJSON, _ := json.Marshal([]map[string]any{{
		"function": map[string]any{
			"name":      toolName,
			"arguments": validatedArgs,
		},
	}})

	// Tool result sent back to the model as the "tool" role message.
	toolResult, _ := json.Marshal(map[string]any{
		"status":  "success",
		"task_id": taskID,
		"title":   validatedArgs["title"],
	})

	// Build a fresh slice to avoid mutating the original firstTurnMessages.
	followUp := append(
		append([]llm.Message{}, firstTurnMessages...),
		llm.Message{Role: "assistant", Content: "", ToolCalls: toolCallsJSON},
		llm.Message{Role: "tool", Content: string(toolResult)},
	)

	summaryCh, err := llm.StreamChat(ctx, followUp, nil)
	if err != nil {
		emit(ctx, out, AgentEvent{
			Kind:   EventError,
			ErrMsg: fmt.Sprintf("summary stream: %v", err),
		})
		return
	}

	for sc := range summaryCh {
		if sc.Kind == llm.KindText {
			emit(ctx, out, AgentEvent{Kind: EventText, Text: sc.Text})
		}
	}
}

// emit sends e to ch while respecting ctx cancellation.
func emit(ctx context.Context, ch chan<- AgentEvent, e AgentEvent) {
	select {
	case ch <- e:
	case <-ctx.Done():
	}
}
