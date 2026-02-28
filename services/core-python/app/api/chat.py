import json
from typing import AsyncGenerator, Literal

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from app.agent.rag import ask_knowledge_base
from app.agent.task_agent import handle_agent_task
from app.database.task_repository import TaskRepository
from app.vector.qdrant import VectorStore

router = APIRouter()

# ── Request model ─────────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    query: str
    # "rag"   → knowledge-base Q&A (embed → Qdrant → LLM)
    # "agent" → task-creation agentic loop (LLM + tool + DB write)
    # Defaults to "agent" when omitted.
    mode: Literal["rag", "agent"] = "agent"

    @field_validator("query")
    @classmethod
    def query_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("query must not be empty")
        return v.strip()


# ── SSE helpers ───────────────────────────────────────────────────────────────


def _sse_frame(event: str, data: dict) -> str:
    """Return one complete SSE frame as a string.

    Format:
        event: <name>\\n
        data: <json>\\n
        \\n
    """
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ── Event-stream generator ────────────────────────────────────────────────────


async def _event_stream(
    req: ChatRequest,
    task_repo: TaskRepository,
    vector_store: VectorStore,
) -> AsyncGenerator[str, None]:
    """Async generator that drives the chosen pipeline and maps every event
    to its canonical SSE frame defined in shared/api/sse_payloads.json.

    Wraps the entire pipeline in a try/except so that unexpected exceptions
    (e.g. Ollama unreachable) surface as a final ``event: error`` frame
    rather than silently closing the stream.
    """
    try:
        if req.mode == "rag":
            async for chunk in ask_knowledge_base(req.query, vector_store):
                if chunk.kind == "text" and chunk.content:
                    yield _sse_frame("message", {"content": chunk.content})

        else:  # "agent"
            async for event in handle_agent_task(req.query, task_repo):
                match event.kind:

                    case "text":
                        # Skip empty tokens — Ollama occasionally emits them
                        # on the final done=true frame.
                        if event.content:
                            yield _sse_frame("message", {"content": event.content})

                    case "tool_call":
                        # UI uses this to show a loading / executing state.
                        yield _sse_frame("tool_call", {
                            "tool": event.tool,
                            "status": "executing",
                            "args": event.args,
                        })

                    case "tool_done":
                        # task_id serialised as string to match the shared schema.
                        yield _sse_frame("tool_result", {
                            "tool": event.tool,
                            "status": "success",
                            "task_id": str(event.task_id),
                        })

                    case "error":
                        yield _sse_frame("tool_result", {
                            "tool": event.tool,
                            "status": "error",
                            "error_msg": event.message,
                        })

    except Exception as exc:  # noqa: BLE001
        # Pipeline-level failure (e.g. Ollama unreachable, Qdrant down).
        # Yield an error frame so the client knows the stream terminated
        # abnormally rather than receiving a silent close.
        yield _sse_frame("error", {"error": str(exc)})


# ── Route ─────────────────────────────────────────────────────────────────────


@router.post("/api/v1/chat")
async def chat(body: ChatRequest, request: Request) -> StreamingResponse:
    """Stream an LLM response as Server-Sent Events.

    Pydantic validates and coerces *body* before this function is called,
    so a malformed or empty query still returns HTTP 422 — the stream is
    never opened for an invalid request.

    Client disconnection is handled automatically: uvicorn cancels the
    async generator when the underlying TCP connection closes, which
    propagates through httpx into the Ollama streaming request.
    """
    task_repo: TaskRepository = request.app.state.task_repo
    vector_store: VectorStore = request.app.state.vector_store

    return StreamingResponse(
        _event_stream(body, task_repo, vector_store),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # prevents nginx from buffering the stream
        },
    )
