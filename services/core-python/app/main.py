import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI

from app.api.chat import router as chat_router
from app.database.pool import create_pool
from app.database.task_repository import TaskRepository
from app.vector.qdrant import VectorStore, create_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- PostgreSQL ---
    dsn = os.getenv(
        "DATABASE_URL",
        "postgresql://admin:secretpassword@localhost:5432/agent_db",
    )
    pool = await create_pool(dsn)
    app.state.task_repo = TaskRepository(pool)

    # --- Qdrant ---
    qdrant_host = os.getenv("QDRANT_HOST", "localhost")
    qdrant_port = int(os.getenv("QDRANT_PORT", "6333"))
    qdrant_client = create_client(host=qdrant_host, port=qdrant_port)
    vector_store = VectorStore(qdrant_client)
    await vector_store.init_collection()
    app.state.vector_store = vector_store

    yield  # server is live and handling requests here

    await pool.close()
    await qdrant_client.close()


app = FastAPI(lifespan=lifespan)
app.include_router(chat_router)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "core-python",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
