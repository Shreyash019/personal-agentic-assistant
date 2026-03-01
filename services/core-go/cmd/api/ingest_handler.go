package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"core-go/internal/agent"
)

// ── Request / Response types ───────────────────────────────────────────────────

// ingestRequest is the JSON body accepted by POST /api/v1/documents.
// text is the raw content to chunk, embed, and store in Qdrant.
// source is an optional human-readable label (filename, URL, title) stored in
// each chunk's payload for provenance tracking.
// user_id tags chunks so retrieval is scoped per-user; use "admin" for shared
// knowledge accessible by all users. Defaults to "admin" when omitted so that
// documents ingested without a user_id are treated as shared knowledge.
type ingestRequest struct {
	Text   string `json:"text"`
	Source string `json:"source"`
	UserID string `json:"user_id"`
}

// ingestResponse is returned on success.
type ingestResponse struct {
	ChunksIngested int    `json:"chunks_ingested"`
	Source         string `json:"source"`
}

// ── Handler ───────────────────────────────────────────────────────────────────

// ingestHandler returns an http.HandlerFunc for POST /api/v1/documents.
//
// It accepts a JSON body with "text" (required) and "source" (optional),
// chunks the text into overlapping windows, embeds each chunk via Ollama
// nomic-embed-text, and upserts all resulting vectors into the Qdrant
// "Personal Context" collection.
//
// On success it returns JSON: {"chunks_ingested": N, "source": "..."}
// On error it returns an HTTP error status with a plain-text message.
//
// Embedding N chunks makes N sequential calls to Ollama. For very large
// documents this can take several seconds; callers should set an appropriate
// client-side timeout (30 s is usually sufficient for up to ~50 chunks).
func ingestHandler(kb *agent.KnowledgeBase) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {

		// ── 1. Parse body ──────────────────────────────────────────────────
		r.Body = http.MaxBytesReader(w, r.Body, 4<<20) // 4 MB cap

		var req ingestRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		if strings.TrimSpace(req.Text) == "" {
			http.Error(w, `"text" must be a non-empty string`, http.StatusBadRequest)
			return
		}

		// Default source label when caller omits it.
		if strings.TrimSpace(req.Source) == "" {
			req.Source = "untitled"
		}

		// Default user_id to "admin" so documents without an explicit owner
		// are treated as shared knowledge, retrievable by all users.
		if strings.TrimSpace(req.UserID) == "" {
			req.UserID = "admin"
		}

		// ── 2. Chunk → embed → upsert ──────────────────────────────────────
		n, err := kb.IngestText(r.Context(), req.Text, req.Source, req.UserID)
		if err != nil {
			http.Error(w, "ingest failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// ── 3. Respond ────────────────────────────────────────────────────
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ingestResponse{
			ChunksIngested: n,
			Source:         req.Source,
		})
	}
}
