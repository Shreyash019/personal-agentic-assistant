# Personal Agentic Assistant — Feature Documentation

> Local-first, privacy-focused mobile assistant. All inference runs on-device via Ollama. No data leaves your machine.

---

## Architecture Overview

```
React Native (Expo)
       │  XHR SSE + REST
       ▼
Go Backend (:8080)
  ├── POST /api/v1/chat        → RAG or Agent pipeline (SSE)
  ├── POST /api/v1/documents   → Ingest text into Qdrant
  ├── GET  /api/v1/tasks       → List user tasks
  ├── PATCH /api/v1/tasks/{id} → Update task status
  └── DELETE /api/v1/tasks/{id}→ Delete a task
       │
  ┌────┴─────────────┐
  │                  │
Ollama             Qdrant          PostgreSQL
(llama3.1:8b       (Personal       (tasks table)
 nomic-embed-text)  Context)
```

---

## User Identity

Every device generates a **UUID v4** on first launch, stored in `AsyncStorage`. This UUID is sent with every request as `user_id` and serves as a lightweight, zero-auth identity layer appropriate for a local-first single-user app.

**Client hook:** [`hooks/use-user-id.ts`](../client/personal-agentic-assistant/hooks/use-user-id.ts)

```
First launch  → generate UUID → store in AsyncStorage → return UUID
Subsequent    → load from AsyncStorage → return UUID
```

The UUID scopes:
- RAG retrieval (admin knowledge + this user's personal context)
- Task creation, listing, update, and deletion

---

## Feature 1: Personalized RAG Chat

### How It Works

```
User message
     │
     ▼
Embed query (nomic-embed-text, 768 dims)
     │
     ▼
Qdrant search — filter: user_id IN ["admin", <userID>]
     │                   top-k = 3, score threshold = 0.30
     ▼
Filter low-score chunks (< 0.30 cosine similarity)
     │
     ▼
Build context: [1] admin chunk … [N] user chunk … [N+] built-in facts
     │
     ▼
Stream llama3.1:8b (strict "answer from context only" prompt)
     │
     ▼
SSE event: message → client renders token-by-token
```

### Two Document Tiers

| Tier | `user_id` in payload | Visible to |
|------|----------------------|------------|
| Admin / shared knowledge | `"admin"` | All users |
| Personal context | `"<uuid>"` | That user only |

### Triggering RAG Mode

Include a system message containing `"knowledge"` or `"rag"` in the messages array:

```json
{
  "messages": [
    { "role": "system", "content": "Use RAG knowledge mode" },
    { "role": "user",   "content": "What hardware do I use?" }
  ],
  "stream": true,
  "user_id": "<your-uuid>"
}
```

### Ingesting Documents

**Admin / shared document** (omit `user_id` or set to `"admin"`):
```bash
curl -X POST http://localhost:8080/api/v1/documents \
  -H 'Content-Type: application/json' \
  -d '{"text":"...","source":"company-handbook.txt"}'
```

**Personal context** (set `user_id` to the device UUID):
```bash
curl -X POST http://localhost:8080/api/v1/documents \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "My name is Shreyash. I use Apple Silicon. I prefer concise answers.",
    "source": "about-me.txt",
    "user_id": "<your-uuid>"
  }'
```

**Response:**
```json
{ "chunks_ingested": 2, "source": "about-me.txt" }
```

### Chunking Strategy

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Chunk size | 400 characters | ~80–100 tokens; focused enough for high-precision retrieval |
| Overlap | 50 characters | Preserves sentence context at chunk boundaries |
| Score threshold | 0.30 cosine | Filters semantically unrelated results before LLM call |
| Top-k | 3 | Keeps context window tight; most relevant chunks surface naturally |

### Built-in Knowledge

The RAG prompt always appends 6 hardcoded facts about GenAI / LLMs / RAG. These act as a semantic floor so the model can answer general questions even when the vector store is empty.

---

## Feature 2: Agent-Based Task Management

### Creating Tasks (via Chat)

Any message that expresses intent to create a task routes through the **agent pipeline** (no system message needed). The model calls the `create_task` tool with structured arguments:

```
User: "Create a high priority task: submit tax documents by Friday"
     │
     ▼
Ollama (llama3.1:8b + create_task tool)
     │
     ▼ tool_call
Validate args: { title (required), description, priority enum }
     │
     ▼
INSERT INTO tasks (title, description, priority, user_id) RETURNING id
     │
     ├── SSE event: tool_call  → UI shows "Executing Task…" banner
     ├── SSE event: tool_result → banner dismissed, system message shown
     └── SSE event: message    → LLM confirmation summary streamed
```

**Tool schema** (`shared/tools/create_task.json`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | ✅ | Max 50 chars, actionable |
| `description` | string | ❌ | Detailed steps or context |
| `priority` | `"low"` \| `"medium"` \| `"high"` | ✅ | Defaults to `"medium"` |

### Viewing & Managing Tasks

Tasks are displayed in the **Tasks tab** of the mobile app, fetched from:

```
GET /api/v1/tasks?user_id=<uuid>
```

Each task card shows:
- Title (with strikethrough when done)
- Priority badge (LOW / MEDIUM / HIGH, colour-coded)
- Status pill (Pending / In Progress / Done)
- Creation date

**Actions available on each card:**

| Action | Endpoint | Body / Query |
|--------|----------|--------------|
| Mark Done / Undo | `PATCH /api/v1/tasks/{id}` | `{ status, user_id }` |
| Delete | `DELETE /api/v1/tasks/{id}?user_id=` | — |

**Status lifecycle:**

```
pending  →  in_progress  →  done
   ↑____________________________|   (undo via Mark Done toggle)
```

### REST API Reference

#### List Tasks
```
GET /api/v1/tasks?user_id=<uuid>
```
Response: `Task[]` ordered newest-first.

```json
[
  {
    "id": 7,
    "title": "Submit tax documents",
    "description": "By this Friday",
    "priority": "high",
    "status": "pending",
    "user_id": "abc123",
    "created_at": "2026-03-01T10:30:00Z"
  }
]
```

#### Update Status
```
PATCH /api/v1/tasks/{id}
Content-Type: application/json

{ "status": "done", "user_id": "<uuid>" }
```
Response: `{ "id": 7, "status": "done" }`

#### Delete Task
```
DELETE /api/v1/tasks/{id}?user_id=<uuid>
```
Response: `204 No Content`

---

## Feature 3: Admin Topic Management (Closed-Domain RAG)

### Overview

As an admin you define the exact topics the assistant is allowed to discuss. The LLM is **strictly restricted** to those topics — it cannot fall back on general training knowledge. If a user asks something outside the configured topics, the assistant responds with:

> "This question is outside my knowledge boundary. I can only answer questions based on the topics I have been configured with."

This boundary check is enforced in two layers:
1. **Score threshold** — any chunk with cosine similarity < 0.30 is discarded.
2. **Early return** — if zero chunks pass the threshold the LLM is never called; the static boundary message is streamed directly.

### Topic File Format

Create one `.txt` or `.md` file per topic in a directory of your choice:

```
topics/
  pricing.md
  refund-policy.txt
  product-features.md
  onboarding.txt
  ...
```

Each file can contain as much detail as needed. The CLI chunks each file into 400-character overlapping windows, so long files are handled automatically.

### Ingesting Topics (Admin CLI)

```bash
cd services/core-go
go run ./cmd/admin -dir ./topics
```

Optional flags:

| Flag | Default | Description |
|------|---------|-------------|
| `-dir` | *(required)* | Directory containing `.txt` / `.md` files |
| `-qdrant` | `http://localhost:6333` | Qdrant base URL |

**Example output:**

```
qdrant: collection "Personal Context" ready (768 dims)

  ✓ pricing.md                              3 chunk(s)
  ✓ refund-policy.txt                       2 chunk(s)
  ✓ product-features.md                     5 chunk(s)
  ✓ onboarding.txt                          4 chunk(s)

─────────────────────────────────────────────────────
Ingested : 4 file(s), 14 chunk(s) → user_id = "admin"
```

All chunks are tagged `user_id = "admin"` so they are visible to every user in chat.

### Re-ingesting / Updating Topics

Simply re-run the CLI after editing your topic files. Each run generates new point IDs, so the old chunks remain alongside the new ones. To replace existing content cleanly:

1. Delete the Qdrant collection: `curl -X DELETE http://localhost:6333/collections/Personal%20Context`
2. Re-ingest: `go run ./cmd/admin -dir ./topics`

The API server will recreate the collection on next startup (or immediately if restarted).

### Topic Boundary in Practice

| Situation | What happens |
|-----------|-------------|
| Query matches an ingested topic (score ≥ 0.30) | LLM answers from those chunks only |
| Query is related but below threshold | Static boundary message, no LLM call |
| Query is completely off-topic | Static boundary message, no LLM call |
| No topics ingested at all | Every query returns boundary message |

### Triggering RAG (Admin Topics) Mode in Chat

Include `"knowledge"` or `"rag"` anywhere in a system message:

```json
{
  "messages": [
    { "role": "system", "content": "Use RAG knowledge mode" },
    { "role": "user",   "content": "What is the refund window?" }
  ],
  "stream": true,
  "user_id": "<user-uuid>"
}
```

---

## Running Locally

### Prerequisites

| Service | How to start |
|---------|-------------|
| PostgreSQL | `docker compose up -d postgres` |
| Qdrant | `docker compose up -d qdrant` |
| Ollama | Already running on macOS (native) |
| Go backend | `cd services/core-go && go run ./cmd/api/` |
| Expo client | `cd client/personal-agentic-assistant && npx expo install && npx expo start` |

### DB Migration (existing installs)

The `init.sql` now includes `user_id` on tasks. If you have an existing database run:

```bash
docker exec -i $(docker ps --filter "name=postgres" -q | head -1) \
  psql -U admin -d agent_db -c \
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id VARCHAR(255) NOT NULL DEFAULT 'default';
   CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks (user_id);"
```

### Install client dependency

```bash
cd client/personal-agentic-assistant
npx expo install @react-native-async-storage/async-storage
```

---

## End-to-End Test Flow

```bash
# 1. Ingest personal context
curl -X POST http://localhost:8080/api/v1/documents \
  -H 'Content-Type: application/json' \
  -d '{"text":"My name is Shreyash. I prefer concise answers.","source":"about-me.txt","user_id":"test-uuid"}'

# 2. RAG chat — should answer from ingested context
curl -N -X POST http://localhost:8080/api/v1/chat \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"messages":[{"role":"system","content":"Use RAG knowledge mode"},{"role":"user","content":"What is my name?"}],"stream":true,"user_id":"test-uuid"}'

# 3. Create a task via chat
curl -N -X POST http://localhost:8080/api/v1/chat \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"messages":[{"role":"user","content":"Create a high priority task: file taxes by Friday"}],"stream":true,"user_id":"test-uuid"}'

# 4. List tasks
curl http://localhost:8080/api/v1/tasks?user_id=test-uuid

# 5. Mark task 1 as done
curl -X PATCH http://localhost:8080/api/v1/tasks/1 \
  -H 'Content-Type: application/json' \
  -d '{"status":"done","user_id":"test-uuid"}'

# 6. Delete task 1
curl -X DELETE "http://localhost:8080/api/v1/tasks/1?user_id=test-uuid"
```
