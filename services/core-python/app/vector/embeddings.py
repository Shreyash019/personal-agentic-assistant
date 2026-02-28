import httpx

OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"

# Separate connect vs. read timeouts: connecting to a local process should be
# fast; reading the embedding response may take several seconds on first load.
_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=5.0, pool=5.0)


async def embed(text: str, base_url: str = OLLAMA_URL) -> list[float]:
    """Send *text* to the local Ollama instance and return the raw embedding vector.

    Uses nomic-embed-text which produces 768-dimensional float vectors,
    matching the Qdrant collection configured in VectorStore.

    Timeout behaviour:
        connect: 5s  — local process should respond immediately.
        read:   30s  — model may need a moment on first load or for long input.

    Raises:
        httpx.ConnectTimeout:  Ollama not reachable within 5s.
        httpx.ReadTimeout:     Ollama did not return a response within 30s.
        httpx.HTTPStatusError: Ollama returned a non-2xx status.
        ValueError:            Ollama returned a 200 with an empty embedding.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(
            f"{base_url}/api/embeddings",
            json={"model": EMBEDDING_MODEL, "prompt": text},
        )
        response.raise_for_status()

    vector: list[float] = response.json().get("embedding", [])
    if not vector:
        raise ValueError("ollama returned an empty embedding vector")

    return vector
