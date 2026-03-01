package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"core-go/internal/agent"
	"core-go/internal/db"
	"core-go/internal/vector"
)

var allowedOrigins = func() map[string]bool {
	raw := strings.TrimSpace(os.Getenv("ALLOWED_ORIGINS"))
	if raw == "" {
		return map[string]bool{
			"http://localhost:3000": true,
			"http://localhost:5173": true,
			"http://127.0.0.1:3000": true,
			"http://127.0.0.1:5173": true,
		}
	}
	set := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(part)
		if origin != "" {
			set[origin] = true
		}
	}
	return set
}()

type loggingResponseWriter struct {
	http.ResponseWriter
	status       int
	bytesWritten int
}

func (lrw *loggingResponseWriter) WriteHeader(status int) {
	lrw.status = status
	lrw.ResponseWriter.WriteHeader(status)
}

func (lrw *loggingResponseWriter) Write(b []byte) (int, error) {
	if lrw.status == 0 {
		lrw.status = http.StatusOK
	}
	n, err := lrw.ResponseWriter.Write(b)
	lrw.bytesWritten += n
	return n, err
}

func (lrw *loggingResponseWriter) Flush() {
	if flusher, ok := lrw.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// requestLoggerMiddleware logs one line per request with method, path,
// response status, response bytes, caller address, and latency.
func requestLoggerMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingResponseWriter{ResponseWriter: w}

		next.ServeHTTP(lrw, r)

		status := lrw.status
		if status == 0 {
			status = http.StatusOK
		}

		log.Printf("http: method=%s path=%s status=%d bytes=%d remote=%s duration=%s",
			r.Method,
			r.URL.Path,
			status,
			lrw.bytesWritten,
			r.RemoteAddr,
			time.Since(start).Round(time.Millisecond),
		)
	})
}

// corsMiddleware adds permissive CORS headers so the admin React panel
// (running on a different port, e.g. localhost:5173) can reach this API.
// For production, restrict Access-Control-Allow-Origin to the panel's origin.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" {
			if !allowedOrigins[origin] {
				if r.Method == http.MethodOptions {
					http.Error(w, "origin not allowed", http.StatusForbidden)
					return
				}
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}

		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, X-Admin-Token")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-site")
		next.ServeHTTP(w, r)
	})
}

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
	mux.Handle("POST /api/v1/documents", adminAuthMiddleware(http.HandlerFunc(ingestHandler(kb))))
	mux.HandleFunc("GET /api/v1/tasks", listTasksHandler(taskRepo))
	mux.HandleFunc("PATCH /api/v1/tasks/{id}", updateTaskHandler(taskRepo))
	mux.HandleFunc("DELETE /api/v1/tasks/{id}", deleteTaskHandler(taskRepo))

	// ── Admin panel routes ────────────────────────────────────────────────────
	mux.Handle("GET /api/v1/admin/documents", adminAuthMiddleware(http.HandlerFunc(listAdminDocsHandler(qdrantClient))))
	mux.Handle("DELETE /api/v1/admin/documents", adminAuthMiddleware(http.HandlerFunc(deleteAdminDocHandler(qdrantClient))))
	mux.Handle("PUT /api/v1/admin/documents", adminAuthMiddleware(http.HandlerFunc(updateAdminDocHandler(qdrantClient, kb))))

	// ── Server ────────────────────────────────────────────────────────────────
	server := &http.Server{
		Addr:              ":8080",
		Handler:           requestLoggerMiddleware(securityHeadersMiddleware(corsMiddleware(mux))),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	if adminAuthEnabled() {
		log.Printf("security: admin token auth enabled for /api/v1/admin/* and /api/v1/documents")
	} else {
		log.Printf("security: admin token auth disabled (set ADMIN_API_KEY to enable)")
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
