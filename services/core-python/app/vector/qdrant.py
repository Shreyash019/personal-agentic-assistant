from qdrant_client import AsyncQdrantClient
from qdrant_client.http.models import Distance, ScoredPoint, VectorParams

COLLECTION_NAME = "Personal Context"
VECTOR_SIZE = 768  # matches nomic-embed-text output dimensions
TOP_K = 3


def create_client(host: str = "localhost", port: int = 6333) -> AsyncQdrantClient:
    """Return an AsyncQdrantClient pointed at the given Qdrant instance.

    Qdrant does not require an explicit connection handshake, so this is a
    synchronous factory — no await needed. Caller must call client.close()
    on shutdown.
    """
    return AsyncQdrantClient(host=host, port=port)


class VectorStore:
    def __init__(self, client: AsyncQdrantClient) -> None:
        self._client = client

    async def init_collection(self) -> None:
        """Create the 'Personal Context' collection if it does not already exist.

        Safe to call on every startup — skips creation when the collection is
        present so existing vectors are not wiped.
        """
        exists = await self._client.collection_exists(COLLECTION_NAME)
        if not exists:
            await self._client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(
                    size=VECTOR_SIZE,
                    distance=Distance.COSINE,
                ),
            )

    async def query(
        self,
        vector: list[float],
        limit: int = TOP_K,
    ) -> list[ScoredPoint]:
        """Return the nearest neighbours to *vector* ranked by Cosine similarity.

        Args:
            vector: A 768-dimensional float embedding from nomic-embed-text.
            limit:  Number of results to return. Defaults to 3.

        Returns:
            Ordered list of ScoredPoint (highest score first). Each point
            exposes .id, .score, and .payload.
        """
        response = await self._client.query_points(
            collection_name=COLLECTION_NAME,
            query=vector,
            limit=limit,
            with_payload=True,
        )
        return response.points
