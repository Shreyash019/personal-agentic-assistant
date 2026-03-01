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

// createTaskArgs mirrors the arguments schema in shared/tools/create_task.json.
// Priority is a string enum — never an integer.
type createTaskArgs struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
}

// validPriorities is the canonical set from shared/tools/create_task.json.
var validPriorities = map[string]bool{"low": true, "medium": true, "high": true}

var taskIntentHints = []string{
	"create a task",
	"create task",
	"add a task",
	"add task",
	"create a todo",
	"add a todo",
	"new task",
	"todo",
	"to-do",
	"remind me",
	"set a reminder",
	"remember to",
	"add this to my tasks",
	"task:",
}

var taskQueryHints = []string{
	"my task",
	"my tasks",
	"list tasks",
	"show tasks",
	"show my tasks",
	"what are my tasks",
	"any task",
	"pending task",
	"pending tasks",
	"today task",
	"today tasks",
	"do i have any tasks",
}

var taskIntentActionWords = []string{
	"create",
	"add",
	"set",
	"remember",
	"remind",
	"track",
	"schedule",
	"note",
	"record",
}

var taskIntentSubjectWords = []string{
	"task",
	"todo",
	"to-do",
	"reminder",
	"deadline",
	"follow-up",
	"follow up",
}

var nonTaskQuestionPrefixes = []string{
	"what",
	"why",
	"how",
	"who",
	"where",
	"when",
	"explain",
	"tell me",
	"can you explain",
}

func looksLikeTaskIntent(userMessage string) bool {
	lc := strings.ToLower(strings.TrimSpace(userMessage))
	if lc == "" {
		return false
	}

	for _, hint := range taskIntentHints {
		if strings.Contains(lc, hint) {
			return true
		}
	}

	if strings.HasPrefix(lc, "task ") || strings.HasPrefix(lc, "todo ") {
		return true
	}

	startsLikeQuestion := false
	for _, prefix := range nonTaskQuestionPrefixes {
		if strings.HasPrefix(lc, prefix+" ") || lc == prefix {
			startsLikeQuestion = true
			break
		}
	}

	hasActionWord := false
	for _, word := range taskIntentActionWords {
		if strings.Contains(lc, word) {
			hasActionWord = true
			break
		}
	}

	hasSubjectWord := false
	for _, word := range taskIntentSubjectWords {
		if strings.Contains(lc, word) {
			hasSubjectWord = true
			break
		}
	}

	if hasActionWord && hasSubjectWord {
		return true
	}

	if startsLikeQuestion {
		return false
	}

	return false
}

func looksLikeTaskQuery(userMessage string) bool {
	lc := strings.ToLower(strings.TrimSpace(userMessage))
	if lc == "" {
		return false
	}

	for _, hint := range taskQueryHints {
		if strings.Contains(lc, hint) {
			return true
		}
	}

	if strings.HasPrefix(lc, "task ") || strings.HasPrefix(lc, "tasks ") {
		return true
	}

	return false
}

// ShouldUseTaskAgent decides if a user query should be routed to the task
// agent pipeline (task creation or task list/query), optionally forced by UI.
func ShouldUseTaskAgent(userMessage string, forceTask bool) bool {
	if forceTask {
		return true
	}
	return looksLikeTaskIntent(userMessage) || looksLikeTaskQuery(userMessage)
}

func validateCreateTaskArgs(raw json.RawMessage) (createTaskArgs, error) {
	var args createTaskArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return args, fmt.Errorf("unmarshal args: %w", err)
	}
	if strings.TrimSpace(args.Title) == "" {
		return args, fmt.Errorf("'title' is required and must be non-empty")
	}
	if args.Priority == "" {
		args.Priority = "medium" // schema default
	}
	if !validPriorities[args.Priority] {
		return args, fmt.Errorf("'priority' must be one of low|medium|high, got %q", args.Priority)
	}
	return args, nil
}

// --- System prompt ---

const agentSystemPrompt = `You are a personal task management assistant.
When the user wants to create, add, or record a task, use the create_task tool.
Extract the task title (required), description (if mentioned), and priority
(if mentioned; must be "low", "medium", or "high"; default "medium").
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
// userID is the device-generated UUID of the requesting user. It is stored
// alongside the task so tasks are per-user. Pass "admin" for system tasks.
//
//  1. Checks whether userMessage is explicit task intent.
//  2. If yes, sends userMessage to Ollama with the create_task tool attached.
//     If not, sends userMessage without tools for normal conversational chat.
//  2. If Ollama returns a ToolCall chunk:
//     a. Validates the extracted args (title required, priority enum).
//     b. Emits EventToolCall so the UI can show a loading state.
//     c. Calls TaskRepository.CreateTask with userID.
//     d. Emits EventToolDone with the generated task ID.
//     e. Sends a tool-result confirmation back to Ollama for a final summary.
//  3. Streams all LLM text tokens as EventText.
func (ta *TaskAgent) HandleAgentTask(ctx context.Context, userMessage, userID string, forceTask bool) (<-chan AgentEvent, error) {
	if looksLikeTaskQuery(userMessage) && !forceTask {
		return ta.handleTaskListQuery(ctx, userID)
	}

	messages := []llm.Message{
		{Role: "system", Content: agentSystemPrompt},
		{Role: "user", Content: userMessage},
	}

	var tools []llm.Tool
	if forceTask || looksLikeTaskIntent(userMessage) {
		tools = []llm.Tool{llm.CreateTaskTool}
	}

	ch, err := llm.StreamChat(ctx, messages, tools)
	if err != nil {
		return nil, fmt.Errorf("agent: start stream: %w", err)
	}

	out := make(chan AgentEvent, 16)
	go ta.runLoop(ctx, ch, messages, userID, out)
	return out, nil
}

func (ta *TaskAgent) handleTaskListQuery(ctx context.Context, userID string) (<-chan AgentEvent, error) {
	tasks, err := ta.repo.ListTasks(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("agent: list tasks: %w", err)
	}

	message := "You don't have any tasks yet."
	if len(tasks) > 0 {
		limit := len(tasks)
		if limit > 5 {
			limit = 5
		}

		lines := make([]string, 0, limit+2)
		lines = append(lines, "Here are your tasks:")
		for i := 0; i < limit; i++ {
			t := tasks[i]
			lines = append(lines, fmt.Sprintf("%d) %s [%s | %s]", i+1, t.Title, t.Status, t.Priority))
		}
		if len(tasks) > limit {
			lines = append(lines, fmt.Sprintf("...and %d more.", len(tasks)-limit))
		}
		message = strings.Join(lines, "\n")
	}

	out := make(chan AgentEvent, 1)
	go func() {
		defer close(out)
		emit(ctx, out, AgentEvent{Kind: EventText, Text: message})
	}()

	return out, nil
}

// runLoop reads from the first-turn Chunk channel and orchestrates the
// validation → DB write → second-turn summary flow.
func (ta *TaskAgent) runLoop(
	ctx context.Context,
	ch <-chan llm.Chunk,
	firstTurnMessages []llm.Message,
	userID string,
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

			// Step 2c — execute TaskRepository.CreateTask, scoped to the requesting user.
			taskID, err := ta.repo.CreateTask(ctx, args.Title, args.Description, args.Priority, userID)
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
	fallbackText := fmt.Sprintf("Task created successfully (ID: %d).", taskID)

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
		emit(ctx, out, AgentEvent{Kind: EventText, Text: fallbackText})
		return
	}

	emittedText := false
	for sc := range summaryCh {
		if sc.Kind == llm.KindText {
			emittedText = true
			emit(ctx, out, AgentEvent{Kind: EventText, Text: sc.Text})
		}
	}

	if !emittedText {
		emit(ctx, out, AgentEvent{Kind: EventText, Text: fallbackText})
	}
}

// emit sends e to ch while respecting ctx cancellation.
func emit(ctx context.Context, ch chan<- AgentEvent, e AgentEvent) {
	select {
	case ch <- e:
	case <-ctx.Done():
	}
}
