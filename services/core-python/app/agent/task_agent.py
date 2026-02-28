import json
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Literal

from app.agent.llm import CREATE_TASK_TOOL, stream_chat
from app.database.task_repository import TaskRepository

# --- Agent event types (map 1:1 to sse_payloads.json) ---


@dataclass
class TextEvent:
    """Prose token emitted by the LLM."""
    kind: Literal["text"] = field(default="text", init=False)
    content: str = ""


@dataclass
class ToolCallEvent:
    """Model requested create_task — UI should show a loading state."""
    kind: Literal["tool_call"] = field(default="tool_call", init=False)
    tool: str = ""
    args: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolDoneEvent:
    """Task successfully persisted in Postgres."""
    kind: Literal["tool_done"] = field(default="tool_done", init=False)
    tool: str = ""
    task_id: int = 0


@dataclass
class ErrorEvent:
    """Validation or DB failure — loop terminates after this."""
    kind: Literal["error"] = field(default="error", init=False)
    message: str = ""


AgentEvent = TextEvent | ToolCallEvent | ToolDoneEvent | ErrorEvent

# --- System prompt ---

_AGENT_SYSTEM_PROMPT = (
    "You are a personal task management assistant.\n"
    "When the user wants to create, add, or record a task, use the create_task tool.\n"
    "Extract the task title (required), description (if mentioned), and priority "
    "(if mentioned; 0=low 1=medium 2=high 3=urgent; default 0).\n"
    "If the user's intent is not to create a task, respond conversationally "
    "without using a tool."
)

# --- Schema validation ---


def _validate_args(args: dict[str, Any]) -> tuple[str, str, int]:
    """Validate tool arguments against the create_task schema.

    Returns:
        (title, description, priority) on success.

    Raises:
        ValueError with a descriptive message on any violation.
    """
    title = args.get("title", "")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("'title' is required and must be a non-empty string")

    description = args.get("description", "")
    if not isinstance(description, str):
        raise ValueError("'description' must be a string")

    priority = args.get("priority", 0)
    if not isinstance(priority, int) or not (0 <= priority <= 3):
        raise ValueError(f"'priority' must be an integer 0–3, got {priority!r}")

    return title.strip(), description, priority


# --- Agentic loop ---


async def handle_agent_task(
    user_message: str,
    task_repo: TaskRepository,
) -> AsyncGenerator[AgentEvent, None]:
    """Full agentic loop for task-creation intent.

    Steps:
        1. Sends user_message to Ollama with the create_task tool attached.
        2. If Ollama returns a tool_call chunk:
           a. Validates the extracted args (title required, priority 0–3).
           b. Yields ToolCallEvent so the UI can show a loading state.
           c. Calls TaskRepository.create_task.
           d. Yields ToolDoneEvent with the Postgres-generated task ID.
           e. Sends a tool-result confirmation back to Ollama and streams
              the model's final natural-language summary.
        3. Streams all LLM prose tokens as TextEvent.

    Yields:
        TextEvent, ToolCallEvent, ToolDoneEvent, or ErrorEvent.
    """
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": _AGENT_SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    async for chunk in stream_chat(messages, tools=[CREATE_TASK_TOOL]):

        if chunk.kind == "text":
            yield TextEvent(content=chunk.content)

        elif chunk.kind == "tool_call":

            # Step 2a — validate args against the create_task schema.
            try:
                title, description, priority = _validate_args(chunk.args)
            except ValueError as exc:
                yield ErrorEvent(message=f"tool arg validation: {exc}")
                return

            validated_args = {
                "title": title,
                "description": description,
                "priority": priority,
            }

            # Step 2b — emit tool_call so the UI shows a loading state.
            yield ToolCallEvent(tool=chunk.name, args=validated_args)

            # Step 2c — execute TaskRepository.create_task.
            try:
                task_id = await task_repo.create_task(title, description, priority)
            except Exception as exc:
                yield ErrorEvent(message=f"create task: {exc}")
                return

            # Step 2d — emit tool_done with the Postgres-generated ID.
            yield ToolDoneEvent(tool=chunk.name, task_id=task_id)

            # Step 2e — second turn: feed tool result back to Ollama and
            # stream the model's final natural-language confirmation.
            tool_result = json.dumps({
                "status": "success",
                "task_id": task_id,
                "title": title,
            })

            followup: list[dict[str, Any]] = [
                *messages,
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"function": {"name": chunk.name, "arguments": validated_args}}
                    ],
                },
                {"role": "tool", "content": tool_result},
            ]

            async for summary in stream_chat(followup):
                if summary.kind == "text":
                    yield TextEvent(content=summary.content)

            return  # loop ends after one tool execution
