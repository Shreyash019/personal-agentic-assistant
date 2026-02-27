from datetime import datetime, timezone

from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "core-python",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
