import json
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Literal

import httpx

OLLAMA_URL = "http://localhost:11434"
CHAT_MODEL = "llama3.1:8b"

# No read timeout: streams can run for many seconds.
# Connect timeout catches the common case of Ollama not running.
_STREAM_TIMEOUT = httpx.Timeout(timeout=None, connect=5.0)

# --- Public types ---


@dataclass
class TextChunk:
    """A prose token emitted by the model during streaming."""

    kind: Literal["text"] = field(default="text", init=False)
    content: str = ""


@dataclass
class ToolCallChunk:
    """A tool invocation decided by the model.

    ``args`` is already a dict — Ollama sends ``arguments`` as a parsed
    JSON object, not a JSON string, so no secondary json.loads() is needed.
    """

    kind: Literal["tool_call"] = field(default="tool_call", init=False)
    name: str = ""
    args: dict[str, Any] = field(default_factory=dict)


# Union type for callers that pattern-match on .kind
ChatChunk = TextChunk | ToolCallChunk

# --- Tool schema ---

# Ollama-compatible tool definition for the create_task function.
# Pass this (or a list containing it) to stream_chat().
CREATE_TASK_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "create_task",
        "description": (
            "Create a new task in the database with a title, "
            "optional description, and priority."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short task title",
                },
                "description": {
                    "type": "string",
                    "description": "Detailed description of the task",
                },
                "priority": {
                    "type": "integer",
                    "description": "Priority level: 0 = low, 1 = medium, 2 = high, 3 = urgent",
                },
            },
            "required": ["title"],
        },
    },
}

# --- Streaming client ---


async def stream_chat(
    messages: list[dict[str, str]],
    tools: list[dict[str, Any]] | None = None,
    base_url: str = OLLAMA_URL,
) -> AsyncGenerator[ChatChunk, None]:
    """Stream a chat completion from the local Ollama instance.

    Yields:
        TextChunk   for each prose token the model emits.
        ToolCallChunk  when the model decides to call a tool.

    The generator exits cleanly when:
        - Ollama sends ``"done": true``.
        - The caller breaks / throws into the generator (httpx cleans up).

    Timeout behaviour:
        connect: 5s   — local process should bind immediately.
        read:    None — stream duration is unbounded; use caller-side
                        cancellation (e.g. asyncio.timeout) if needed.

    Raises:
        httpx.ConnectTimeout:  Ollama not reachable within 5s.
        httpx.HTTPStatusError: Ollama returned a non-2xx status.
    """
    payload = {
        "model": CHAT_MODEL,
        "messages": messages,
        "tools": tools or [],
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=_STREAM_TIMEOUT) as client:
        async with client.stream("POST", f"{base_url}/api/chat", json=payload) as response:
            response.raise_for_status()

            async for line in response.aiter_lines():
                if not line:
                    continue

                frame = json.loads(line)
                message = frame.get("message", {})

                # Tool calls: one or more, arrive before the final done=true frame.
                for tc in message.get("tool_calls") or []:
                    fn = tc["function"]
                    yield ToolCallChunk(name=fn["name"], args=fn["arguments"])

                # Text chunk: non-empty content on done=false frames.
                if content := message.get("content"):
                    yield TextChunk(content=content)

                if frame.get("done"):
                    return
