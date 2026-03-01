# 🧠 Personal Agentic Assistant

Local-first mobile assistant with:
- **Knowledge Q&A (RAG)** over ingested topics/docs
- **Agentic task operations** (create/list/update/delete)
- **Real-time SSE streaming** responses in chat

Primary runtime is **Go backend + Expo client + Postgres + Qdrant + Ollama**.

---

## ✅ Current Project Status

Implemented and working:
- Go API on `:8080` with streaming chat endpoint (`/api/v1/chat`)
- Strict topic-bounded RAG with out-of-scope response:
   - `I don't have information on that topic.`
- Task intent routing + manual `force_task` support
- Task query in chat (`What are my tasks?`) returns list response
- Admin document management APIs (list/update/delete/ingest)
- React Native chat UX improvements:
   - compact task toggle
   - task-created inline marker
   - settings tab (`ABOUT`, `PRIVACY POLICY`)
   - inline response-generation animation (typing dots + `Generating…`)
- Security hardening in Go API:
   - strict JSON decoding
   - `user_id` validation
   - optional admin token auth
   - CORS allowlist
   - security headers + server timeouts
   - request logging middleware

---

## 🧱 Stack

- **Mobile Client:** Expo React Native (`client/personal-agentic-assistant`)
- **Primary Backend:** Go (`services/core-go`)
- **Optional/Reference Backend:** Python FastAPI (`services/core-python`)
- **DB:** PostgreSQL (Docker)
- **Vector DB:** Qdrant (Docker)
- **LLM Runtime:** Ollama on macOS (`llama3.1:8b`, `nomic-embed-text`)

---

## 📂 Monorepo Layout

```text
.
├── docker-compose.yml
├── init.sql
├── client/
│   ├── personal-agentic-assistant/   # Expo mobile app
│   └── admin-panel/                  # Admin docs UI
├── services/
│   ├── core-go/                      # Primary Go backend
│   └── core-python/                  # Reference Python backend
├── shared/
│   └── api/                          # JSON request/event contracts
└── tools/
```

---

## 🚀 Run Locally (Recommended Flow)

### 1) Start infra + models

```bash
docker-compose up -d
ollama pull llama3.1:8b
ollama pull nomic-embed-text
ollama serve
```

### 2) Start Go backend

```bash
cd services/core-go
go run ./cmd/api
```

Health check:

```bash
curl http://localhost:8080/health
```

### 3) Start mobile app

```bash
cd client/personal-agentic-assistant
npm install
npx expo start
```

### 4) (Optional) Start admin panel

```bash
cd client/admin-panel
npm install
npm run dev
```

---

## 🔌 API Overview (Go)

Base URL: `http://localhost:8080`

- `GET /health`
- `POST /api/v1/chat` (SSE)
- `POST /api/v1/documents` (ingest; admin-protected when `ADMIN_API_KEY` is set)
- `GET /api/v1/tasks`
- `PATCH /api/v1/tasks/{id}`
- `DELETE /api/v1/tasks/{id}`
- `GET /api/v1/admin/documents`
- `PUT /api/v1/admin/documents`
- `DELETE /api/v1/admin/documents`

Postman collection:
- `shared/api/go-backend.postman_collection.json`

---

## 🧠 Chat Routing Behavior

`POST /api/v1/chat` routes requests as:
- **Task path** when:
   - user intent is task-related, or
   - `force_task: true`
- **RAG path** otherwise

RAG answers only from ingested knowledge scope (`admin + user_id`) and returns boundary text for out-of-scope topics.

---

## 🔐 Security & Config

Important env vars for `services/core-go`:

- `DATABASE_URL` (default: local Postgres)
- `QDRANT_URL` (default: `http://localhost:6333`)
- `ALLOWED_ORIGINS` (comma-separated CORS allowlist)
- `ADMIN_API_KEY` (enables token auth on admin/doc endpoints)
- `RAG_TOP_K`
- `RAG_FALLBACK_TOP_K`
- `RAG_MAX_CONTEXT_CHUNKS`
- `RAG_MIN_TOP_SEMANTIC_SCORE`
- `RAG_MIN_SEMANTIC_FLOOR`
- `RAG_MIN_LEXICAL_SCORE`
- `RAG_LEXICAL_WEIGHT`
- `RAG_SOURCE_HINT_WEIGHT`

When `ADMIN_API_KEY` is set, send `X-Admin-Token` header for:
- `/api/v1/documents`
- `/api/v1/admin/*`

---

## 🧪 Quick Validation Commands

In-scope example:

```bash
curl -N -sS -X POST http://localhost:8080/api/v1/chat \
   -H 'Content-Type: application/json' \
   -d '{"messages":[{"role":"user","content":"Who is Rama?"}],"user_id":"default"}'
```

Out-of-scope example:

```bash
curl -N -sS -X POST http://localhost:8080/api/v1/chat \
   -H 'Content-Type: application/json' \
   -d '{"messages":[{"role":"user","content":"What is tennis?"}],"user_id":"default"}'
```

Task query example:

```bash
curl -N -sS -X POST http://localhost:8080/api/v1/chat \
   -H 'Content-Type: application/json' \
   -d '{"messages":[{"role":"user","content":"What are my tasks?"}],"user_id":"default"}'
```

---

## 🛠️ Common Troubleshooting

- **Client says cannot connect**
   - Ensure Go API is running on `:8080`
   - Ensure mobile `BASE_URL` host in `ChatScreen.tsx` matches your machine/LAN IP for physical devices

- **Chat always out-of-scope**
   - Verify topics were ingested (`GET /api/v1/admin/documents`)
   - Ensure `user_id` scope matches expected visibility (`admin` docs are shared)

- **Admin routes denied (401/403)**
   - Set `X-Admin-Token` when `ADMIN_API_KEY` is enabled
   - Add frontend origin to `ALLOWED_ORIGINS`

---

If you want a full runbook, see `Runner.md`.
