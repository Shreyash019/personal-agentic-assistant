import asyncpg


async def create_pool(dsn: str) -> asyncpg.Pool:
    """Create and return an asyncpg connection pool.

    Raises asyncpg.PostgresError if the DSN is invalid or the server is
    unreachable. Caller is responsible for calling pool.close() on shutdown.
    """
    return await asyncpg.create_pool(
        dsn,
        min_size=2,
        max_size=10,
    )
