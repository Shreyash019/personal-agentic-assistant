# Personal Agentic Assistant (Local-First RAG)
**Engineering Context & Architecture Document**

## 🎯 Project Overview
A local-first, privacy-focused mobile assistant that leverages Retrieval-Augmented Generation (RAG) and Agentic Tool-Calling to process personal context, automate task creation, and generate daily summaries. 

Built as a 3-day engineering sprint, this monorepo explores high-performance systems design by implementing the core orchestration layer in **two separate backend architectures** (Vanilla Go and Python/FastAPI) to benchmark I/O orchestration, JSON parsing overhead, and LLM streaming efficiency.

**Key Objectives:**
1. Showcase production-grade system design and backend architecture.
2. Demonstrate a deep understanding of genuine RAG vs. Agentic workflows.
3. Build a performant, zero-dependency React Native client utilizing Server-Sent Events (SSE).
4. Maintain strict data privacy by running all LLM inference natively and data storage locally.

---

## 🏗️ System Architecture & Tech Stack

### Infrastructure
* **Inference Engine:** [Ollama](https://ollama.com/) running **natively on macOS**. 
  * *Decision:* Bypasses Docker to fully utilize Apple Silicon (Metal API) for maximum tokens/second inference.
  * *Models:* `llama3.1:8b` (Brain/Tool Calling) & `nomic-embed-text` (Vectorization).
* **Relational DB:** PostgreSQL 15 (Dockerized).
* **Vector DB:** Qdrant (Dockerized).

### The Dual-Backend "Bake-Off"
To objectively benchmark performance under LLM streaming loads, the orchestration layer is built twice with strict architectural parity:
* **Backend A (Go 1.22+):** Vanilla `net/http` for zero-dependency routing, concurrent goroutines for streaming via `http.Flusher`, and `jackc/pgx/v5` for high-throughput DB connections.
* **Backend B (Python 3.11+):** FastAPI for native async loop handling, `httpx` for async API calls, `pydantic` for strict JSON validation, and `asyncpg` for raw DB speed.

### Client
* **React Native (Bare CLI):** Avoids heavy UI frameworks. Uses native `fetch` API to consume chunked byte-streams (SSE) and custom `useReducer` hooks to map LLM tool executions to native UI components.

---

## 🧠 Core Workflows: RAG vs. Agentic

This system routes user intent to the appropriate workflow to avoid unnecessary context stuffing.

### 1. Agentic Tool Calling (State Mutation)
* **Flow:** Client → Orchestrator → LLM (llama3.1:8b).
* **Action:** LLM recognizes intent (e.g., "Create a task to review docs") and outputs a strict JSON payload `{"tool": "create_task", "args": {...}}`.
* **Execution:** Orchestrator intercepts JSON, validates it, executes a Postgres `INSERT`, and prompts the LLM to summarize the action.

### 2. True RAG (Knowledge Retrieval)
* **Flow:** Client → Orchestrator → Embedder (nomic-embed-text) → Qdrant → LLM.
* **Action:** User asks a knowledge question. The Orchestrator vectorizes the query, searches Qdrant for the top 3 semantic matches, and injects *only* those specific chunks into the LLM system prompt.

---

## 📂 Monorepo Structure

\`\`\`text
personal-agent-monorepo/
├── docker-compose.yml          # Bootstraps Postgres and Qdrant
├── init.sql                    # Postgres schema (Tasks, History tables)
├── client/                     # React Native App (Bare CLI)
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
\`\`\`

---

## 🚀 Current Setup Status (What we have done so far)

1. **Inference Layer Initialized:** * Ollama installed natively on macOS. 
   * `llama3.1:8b` and `nomic-embed-text` pulled and verified for Metal GPU usage.
2. **Infrastructure Scaffolded:** * `docker-compose.yml` configured for Postgres and Qdrant.
   * `init.sql` created with `tasks` and `chat_history` schemas.
3. **Monorepo Initialized:**
   * Directory structure created.
   * Go backend initialized (`go mod init`, `pgx` installed).
   * Python backend initialized (venv created, `fastapi`, `asyncpg`, `qdrant-client` installed).
   * React Native client scaffolded (`npx react-native init`).

---

## ⏭️ Next Steps

1. **Define Shared Contracts:** Write the strict JSON schemas in the `/shared` folder for the tool-calling definitions so both backends validate identical structures.
2. **Database Connections:** Implement the `asyncpg` (Python) and `pgx` (Go) connection pools.
3. **Build the Orchestrator Routing:** Implement the POST `/chat` endpoints to handle the prompt routing (DB vs Qdrant) and the SSE streaming back to the client.