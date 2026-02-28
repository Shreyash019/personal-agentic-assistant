import asyncpg


class TaskRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def create_task(
        self,
        title: str,
        description: str,
        priority: int,
    ) -> int:
        """Insert a new task and return its generated ID.

        Acquires a connection from the pool for the duration of the query,
        then releases it back automatically via the async context manager.
        Uses positional parameters ($1, $2, $3) — no string interpolation.
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO tasks (title, description, priority)
                VALUES ($1, $2, $3)
                RETURNING id
                """,
                title,
                description,
                priority,
            )
            return row["id"]
