package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"core-go/internal/agent"
	"core-go/internal/db"
	"core-go/internal/vector"
)

type healthResponse struct {
	Status    string `json:"status"`
	Service   string `json:"service"`
	Timestamp string `json:"timestamp"`
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(healthResponse{
		Status:    "ok",
		Service:   "core-go",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
}

func main() {
	ctx := context.Background()

	// ── PostgreSQL ────────────────────────────────────────────────────────────
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://admin:secretpassword@localhost:5432/agent_db"
	}
	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		log.Fatalf("db pool: %v", err)
	}
	defer pool.Close()

	taskRepo := db.NewTaskRepository(pool)

	// ── Qdrant ────────────────────────────────────────────────────────────────
	qdrantURL := os.Getenv("QDRANT_URL")
	if qdrantURL == "" {
		qdrantURL = "http://localhost:6333"
	}
	qdrantClient := vector.NewQdrantClient(qdrantURL)

	// Ensure the "Personal Context" collection exists before serving requests.
	// This is idempotent: if the collection already exists Qdrant returns 200.
	// Doing it at startup avoids a race where the first RAG query arrives
	// before any documents have been ingested.
	if err := qdrantClient.EnsureCollection(ctx, agent.CollectionName(), agent.CollectionDim()); err != nil {
		log.Fatalf("qdrant: ensure collection: %v", err)
	}
	log.Printf("qdrant: collection %q ready (%d dims)", agent.CollectionName(), agent.CollectionDim())

	// ── Agent services ────────────────────────────────────────────────────────
	kb := agent.NewKnowledgeBase(qdrantClient)
	ta := agent.NewTaskAgent(taskRepo)

	// ── Routes ───────────────────────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("POST /api/v1/chat", chatHandler(kb, ta))
	mux.HandleFunc("POST /api/v1/documents", ingestHandler(kb))
	mux.HandleFunc("GET /api/v1/tasks", listTasksHandler(taskRepo))
	mux.HandleFunc("PATCH /api/v1/tasks/{id}", updateTaskHandler(taskRepo))
	mux.HandleFunc("DELETE /api/v1/tasks/{id}", deleteTaskHandler(taskRepo))

	// ── Server ────────────────────────────────────────────────────────────────
	server := &http.Server{
		Addr:    ":8080",
		Handler: mux,
	}

	go func() {
		log.Println("core-go listening on :8080")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Block until SIGINT or SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	log.Println("shutdown signal received, draining connections...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("graceful shutdown failed: %v", err)
	}

	log.Println("shutdown complete")
}
