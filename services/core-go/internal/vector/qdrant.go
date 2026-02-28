package vector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

const searchTimeout = 10 * time.Second

// ScoredPoint is one result returned by a Qdrant similarity search.
// Payload keys depend on how documents were ingested; the RAG pipeline
// expects at least a "text" key holding the raw chunk content.
type ScoredPoint struct {
	ID      any            `json:"id"`
	Score   float64        `json:"score"`
	Payload map[string]any `json:"payload"`
}

// QdrantClient is a thin HTTP wrapper around the Qdrant REST API.
// It is safe for concurrent use.
type QdrantClient struct {
	baseURL string
	http    *http.Client
}

// NewQdrantClient returns a QdrantClient pointed at baseURL
// (e.g. "http://localhost:6333").
func NewQdrantClient(baseURL string) *QdrantClient {
	return &QdrantClient{
		baseURL: baseURL,
		http:    &http.Client{Timeout: searchTimeout},
	}
}

// Search returns up to limit points from collection ranked by cosine similarity
// to vector. Payload is always included in results.
func (q *QdrantClient) Search(
	ctx context.Context,
	collection string,
	vector []float64,
	limit int,
) ([]ScoredPoint, error) {
	type searchReq struct {
		Vector      []float64 `json:"vector"`
		Limit       int       `json:"limit"`
		WithPayload bool      `json:"with_payload"`
	}

	body, err := json.Marshal(searchReq{
		Vector:      vector,
		Limit:       limit,
		WithPayload: true,
	})
	if err != nil {
		return nil, fmt.Errorf("qdrant: marshal: %w", err)
	}

	endpoint := fmt.Sprintf(
		"%s/collections/%s/points/search",
		q.baseURL,
		url.PathEscape(collection), // handles "Personal Context" → "Personal%20Context"
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("qdrant: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := q.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("qdrant: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("qdrant: status %d", resp.StatusCode)
	}

	var result struct {
		Result []ScoredPoint `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("qdrant: decode: %w", err)
	}

	return result.Result, nil
}
