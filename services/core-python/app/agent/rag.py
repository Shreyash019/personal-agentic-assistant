from typing import AsyncGenerator

from app.agent.llm import ChatChunk, stream_chat
from app.vector.embeddings import embed
from app.vector.qdrant import VectorStore

# Intentionally strict: model must answer only from the supplied context.
_SYSTEM_PROMPT = """\
You are a personal knowledge assistant with access to the user's private notes and documents.

Answer the user's question using ONLY the information provided in the CONTEXT section below.
Do NOT draw on any knowledge outside of that context.
If the context does not contain enough information to answer, respond exactly with:
"I don't have enough information about that in my knowledge base."

CONTEXT:
{context}

Answer concisely and directly."""


async def ask_knowledge_base(
    query: str,
    vector_store: VectorStore,
) -> AsyncGenerator[ChatChunk, None]:
    """Full RAG pipeline: embed → search → prompt → stream.

    Steps:
        1. Vectorises *query* via Ollama nomic-embed-text (768 dims).
        2. Retrieves the top-3 nearest chunks from the 'Personal Context'
           collection in Qdrant using Cosine similarity.
        3. Compiles a strict system prompt from the retrieved context chunks.
        4. Streams the LLM response from llama3.1:8b — no tools, pure Q&A.

    Args:
        query:        The user's natural-language question.
        vector_store: Live VectorStore instance (from app.state.vector_store).

    Yields:
        TextChunk for each prose token emitted by the LLM.
    """
    # Step 1: embed the query.
    query_vector = await embed(query)

    # Step 2: retrieve top-3 semantic matches.
    points = await vector_store.query(query_vector)

    # Step 3: compile system prompt from retrieved context.
    if points:
        context = "\n\n".join(
            f"[{i + 1}] {p.payload.get('text', '(empty chunk)')}"
            for i, p in enumerate(points)
        )
    else:
        context = "(no relevant context found)"

    system_prompt = _SYSTEM_PROMPT.format(context=context)

    # Step 4: stream the LLM response — no tools, pure retrieval Q&A.
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": query},
    ]
    async for chunk in stream_chat(messages):
        yield chunk
