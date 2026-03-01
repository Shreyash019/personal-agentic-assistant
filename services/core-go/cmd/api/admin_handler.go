// admin_handler.go — REST endpoints for the admin knowledge-base panel.
//
//	GET    /api/v1/admin/documents           → list all admin docs (grouped by source)
//	DELETE /api/v1/admin/documents?source=X  → delete all chunks for a source
//	PUT    /api/v1/admin/documents?source=X  → replace a source (delete + re-ingest)
package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"core-go/internal/agent"
	"core-go/internal/vector"
)

// adminDocResponse is the JSON shape returned by listAdminDocsHandler.
type adminDocResponse struct {
	Source     string `json:"source"`
	ChunkCount int    `json:"chunk_count"`
	Preview    string `json:"preview"`   // first ~120 chars of reconstructed text
	FullText   string `json:"full_text"` // full reconstructed text for the edit UI
}

// listAdminDocsHandler handles GET /api/v1/admin/documents.
// It scrolls all Qdrant points tagged user_id="admin", groups them by source,
// reconstructs the original text from ordered chunks, and returns a sorted list.
func listAdminDocsHandler(qdrant *vector.QdrantClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		points, err := qdrant.ScrollAdminPoints(r.Context(), agent.CollectionName())
		if err != nil {
			http.Error(w, `{"error":"failed to list documents"}`, http.StatusInternalServerError)
			return
		}

		// Group chunks by source, preserving order.
		type entry struct {
			idx  int
			text string
		}
		grouped := map[string][]entry{}
		for _, p := range points {
			grouped[p.Source] = append(grouped[p.Source], entry{p.ChunkIndex, p.Text})
		}

		docs := make([]adminDocResponse, 0, len(grouped))
		for source, entries := range grouped {
			sort.Slice(entries, func(i, j int) bool {
				return entries[i].idx < entries[j].idx
			})

			chunks := make([]string, len(entries))
			for i, e := range entries {
				chunks[i] = e.text
			}

			fullText := agent.ReconstructText(chunks)

			preview := fullText
			runes := []rune(preview)
			if len(runes) > 120 {
				preview = string(runes[:120]) + "…"
			}

			docs = append(docs, adminDocResponse{
				Source:     source,
				ChunkCount: len(chunks),
				Preview:    preview,
				FullText:   fullText,
			})
		}

		sort.Slice(docs, func(i, j int) bool {
			return strings.ToLower(docs[i].Source) < strings.ToLower(docs[j].Source)
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(docs)
	}
}

// deleteAdminDocHandler handles DELETE /api/v1/admin/documents?source=<source>.
// Removes every Qdrant chunk whose user_id="admin" AND source=<source>.
func deleteAdminDocHandler(qdrant *vector.QdrantClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		source := r.URL.Query().Get("source")
		if source == "" {
			http.Error(w, `{"error":"source query parameter is required"}`, http.StatusBadRequest)
			return
		}
		source = strings.TrimSpace(source)
		if len(source) == 0 || len(source) > 180 {
			http.Error(w, `{"error":"invalid source"}`, http.StatusBadRequest)
			return
		}
		if err := qdrant.DeleteBySource(r.Context(), agent.CollectionName(), source); err != nil {
			http.Error(w, `{"error":"failed to delete document"}`, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// updateAdminDocHandler handles PUT /api/v1/admin/documents?source=<old-source>.
// Body: { "text": "...", "new_source": "..." }
//
// Deletes all chunks for the old source then re-ingests the new text.
// new_source is optional; when omitted the source name is preserved.
func updateAdminDocHandler(qdrant *vector.QdrantClient, kb *agent.KnowledgeBase) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		oldSource := r.URL.Query().Get("source")
		if oldSource == "" {
			http.Error(w, `{"error":"source query parameter is required"}`, http.StatusBadRequest)
			return
		}
		oldSource = strings.TrimSpace(oldSource)
		if len(oldSource) == 0 || len(oldSource) > 180 {
			http.Error(w, `{"error":"invalid source"}`, http.StatusBadRequest)
			return
		}

		var body struct {
			Text      string `json:"text"`
			NewSource string `json:"new_source"`
		}
		if err := decodeJSONStrict(r, &body); err != nil || strings.TrimSpace(body.Text) == "" {
			http.Error(w, `{"error":"text is required"}`, http.StatusBadRequest)
			return
		}

		newSource := strings.TrimSpace(body.NewSource)
		if newSource == "" {
			newSource = oldSource
		}
		if len(newSource) > 180 {
			http.Error(w, `{"error":"new_source is too long"}`, http.StatusBadRequest)
			return
		}

		// Delete existing chunks first.
		if err := qdrant.DeleteBySource(r.Context(), agent.CollectionName(), oldSource); err != nil {
			http.Error(w, `{"error":"failed to remove old document"}`, http.StatusInternalServerError)
			return
		}

		// Re-ingest as admin with the (possibly renamed) source.
		count, err := kb.IngestText(r.Context(), body.Text, newSource, "admin")
		if err != nil {
			http.Error(w, `{"error":"failed to ingest updated document"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"source":          newSource,
			"chunks_ingested": count,
		})
	}
}
