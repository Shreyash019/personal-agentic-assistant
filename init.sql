CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    priority VARCHAR(20) DEFAULT 'medium',
    -- status lifecycle: pending → in_progress → done
    status VARCHAR(50) DEFAULT 'pending',
    -- user_id ties each task to the device-generated UUID of its owner.
    -- 'admin' is reserved for system-level tasks.
    user_id VARCHAR(255) NOT NULL DEFAULT 'default',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for the common per-user list query (GET /api/v1/tasks?user_id=...)
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks (user_id);

CREATE TABLE IF NOT EXISTS chat_history (
    id SERIAL PRIMARY KEY,
    role VARCHAR(50) NOT NULL, -- 'user', 'assistant', or 'system'
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);