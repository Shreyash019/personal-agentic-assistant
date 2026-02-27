# 🧠 Personal Agentic Assistant (Local-First RAG)

A local-first, privacy-focused mobile assistant leveraging Retrieval-Augmented Generation (RAG) and Agentic Tool-Calling to process personal context, automate task creation, and generate daily summaries.

Built in a 3-day engineering sprint, this monorepo explores high-performance systems design by implementing the core orchestration layer in two backend architectures (Vanilla Go and Python/FastAPI) to benchmark I/O orchestration, JSON parsing overhead, and LLM streaming efficiency.

---

## 🏗️ System Architecture

The application operates as a Local AI Microservices Mesh, utilizing Apple Silicon (Metal) for native LLM inference while containerizing the data tier for clean environmental separation.

**Core Stack:**
- **Client:** React Native (Vanilla primitives, zero heavy UI frameworks, custom SSE hooks)
- **Backend A (High-Performance):** Go 1.22+ (Standard Library net/http, jackc/pgx/v5 for Postgres)
- **Backend B (Rapid Iteration):** Python 3.11+ (FastAPI, asyncpg, pydantic)
- **Relational Database:** PostgreSQL (Dockerized)
- **Vector Database:** Qdrant (Dockerized)
- **Inference Engine:** Ollama running natively on macOS (llama3.1:8b for tool calling, nomic-embed-text for vectorization)

**Architectural Diagram:**

```
📱 React Native Client (Mobile)
    │
    ├─ [SSE Stream] ─ HTTP POST /chat ─┐
    │                                  │
    ▼                                  ▼
 🟢 API Gateway (Go / net/http)    🔵 API Gateway (Python / FastAPI)
    │                                  │
    ├──────────────────────────────────┤
    │           Orchestrator           │
    │  (Intent Parsing, Tool Calling)  │
    │                                  │
    ├──────────────┬───────────────────┤
    ▼              ▼                   ▼
 🐘 PostgreSQL   🗂️ Qdrant         🦙 Ollama (Native macOS)
  (Tasks/Notes)  (Embeddings)     (llama3.1:8b + Metal GPU)
```

---

## ⚡ Key Engineering Decisions

1. **Dual-Backend "Bake-Off":**
   - Go (Vanilla): Goroutines for concurrent vector ingestion, net/http for zero-dependency routing. Minimal memory footprint and raw throughput.
   - Python (FastAPI): asyncpg and pure async/await for non-blocking I/O. Skipped heavy abstraction layers for granular control.

2. **Native Inference vs. Dockerized Data:**
   - PostgreSQL and Qdrant run in Docker for clean state management.
   - Ollama runs natively on macOS, bypassing Docker-for-Mac's lack of GPU passthrough, allowing full Metal API utilization.

3. **Resilient Tool Calling (Agentic Loop):**
   - Implements a Retry and Repair Loop for malformed LLM tool arguments, feeding parsing errors back to the LLM as system corrections.

4. **Zero-Dependency Mobile Philosophy:**
   - React Native client avoids heavy chat UI libraries, uses custom useReducer state machine and native fetch for SSE.

---

## 🚀 Features

- **Local-First Ingestion Pipeline:** Securely vectorize and query personal .txt and .md files without external APIs.
- **Agentic Task Management:** Natural language mapped to strict database operations.
- **Real-Time Streaming:** Chunked byte-stream processing from LLM to mobile UI.
- **Daily Summarization:** Background workers generate structured markdown briefings.

---

## 📂 Monorepo Structure

```
personal-agent-monorepo/
├── docker-compose.yml          # Bootstraps Postgres and Qdrant
├── init.sql                    # Postgres schema (Tasks, History tables)
├── client/                     # React Native App
│   ├── src/hooks/              # Custom useSSEChat hook
│   └── src/ui/                 # Core unstyled components
├── services/
│   ├── core-go/                # Vanilla Go Implementation
│   │   ├── cmd/api/            # Entry point
│   │   └── internal/           # Domain logic (Agent, DB, LLM clients)
│   ├── core-python/            # FastAPI Implementation
│   │   ├── app/agent/          # Tool orchestration loop
│   │   └── app/database/       # asyncpg connection pools
└── shared/                     # Cross-service JSON schemas and API contracts
```

---

## 🛠️ Getting Started (Local Development)

**Prerequisites:**
- Docker Desktop
- Go 1.22+ & Python 3.11+
- Node.js & React Native CLI
- Ollama installed natively on macOS

**1. Start Infrastructure**
```bash
docker-compose up -d
ollama run llama3.1:8b
ollama pull nomic-embed-text
```

**2. Run the Backend (Choose One)**

*Go Backend (Port 8080):*
```bash
cd services/core-go
go run cmd/api/main.go
```

*Python Backend (Port 8000):*
```bash
cd services/core-python
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**3. Run the Mobile Client**
```bash
cd client
npm install
npm run ios # or npm run android
```

---

## 📊 Performance Benchmark (WIP)

To be filled after sprint completion.

| Metric                  | Go (net/http + pgx) | Python (FastAPI + asyncpg) |
|-------------------------|---------------------|----------------------------|
| Idle Memory             | ~X MB               | ~Y MB                      |
| Active SSE Memory       | ~X MB               | ~Y MB                      |
| Tool-Call Loop Latency  | X ms                | Y ms                       |

---

Built as a proof-of-work for high-performance systems engineering, RAG architecture, and secure local-first development.
