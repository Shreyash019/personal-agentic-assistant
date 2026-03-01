package vector

import (
	"bytes"
	"context"
	"crypto/rand"
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

// PointInput is a single vector point to upsert into a Qdrant collection.
// ID must be a UUID v4 string. Payload is arbitrary metadata stored alongside
// the vector and returned on retrieval (e.g. {"text": "...", "source": "..."}).
type PointInput struct {
	ID      string         `json:"id"`
	Vector  []float64      `json:"vector"`
	Payload map[string]any `json:"payload"`
}

// NewPointID generates a random UUID v4 string suitable for use as a Qdrant
// point ID. Uses crypto/rand so IDs are collision-resistant.
func NewPointID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
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

// EnsureCollection creates the named Qdrant collection with dim-dimensional
// vectors and Cosine distance if it does not already exist.
// It is idempotent: a 200 (already exists) is treated as success.
func (q *QdrantClient) EnsureCollection(ctx context.Context, collection string, dim int) error {
	type vectorParams struct {
		Size     int    `json:"size"`
		Distance string `json:"distance"`
	}
	type createReq struct {
		Vectors vectorParams `json:"vectors"`
	}

	body, err := json.Marshal(createReq{
		Vectors: vectorParams{Size: dim, Distance: "Cosine"},
	})
	if err != nil {
		return fmt.Errorf("qdrant: ensure_collection marshal: %w", err)
	}

	endpoint := fmt.Sprintf("%s/collections/%s", q.baseURL, url.PathEscape(collection))
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("qdrant: ensure_collection build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := q.http.Do(req)
	if err != nil {
		return fmt.Errorf("qdrant: ensure_collection http: %w", err)
	}
	defer resp.Body.Close()

	// 200 OK = created; Qdrant also returns 200 if it already exists.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("qdrant: ensure_collection status %d", resp.StatusCode)
	}
	return nil
}

// UpsertPoints inserts or updates a batch of points in the named collection.
// Each PointInput must have a unique ID, a vector matching the collection's
// configured dimension, and an arbitrary payload map.
func (q *QdrantClient) UpsertPoints(ctx context.Context, collection string, points []PointInput) error {
	type upsertReq struct {
		Points []PointInput `json:"points"`
	}

	body, err := json.Marshal(upsertReq{Points: points})
	if err != nil {
		return fmt.Errorf("qdrant: upsert marshal: %w", err)
	}

	endpoint := fmt.Sprintf(
		"%s/collections/%s/points",
		q.baseURL,
		url.PathEscape(collection),
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("qdrant: upsert build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := q.http.Do(req)
	if err != nil {
		return fmt.Errorf("qdrant: upsert http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("qdrant: upsert status %d", resp.StatusCode)
	}
	return nil
}

// filterClause is a Qdrant "should" filter that matches points whose user_id
// payload field equals any of the supplied values (logical OR).
// Used to retrieve both admin documents and user-specific documents in one query.
type filterClause struct {
	Should []struct {
		Key   string `json:"key"`
		Match struct {
			Value string `json:"value"`
		} `json:"match"`
	} `json:"should"`
}

// Search returns up to limit points from collection ranked by cosine similarity
// to vector.
//
// userID scoping: when userID is non-empty the results are restricted to
// documents whose payload user_id is either "admin" (shared knowledge) or
// the supplied userID (personal context). Pass an empty string to return all
// documents regardless of ownership (used for admin ingestion checks).
func (q *QdrantClient) Search(
	ctx context.Context,
	collection string,
	vector []float64,
	limit int,
	userID string,
) ([]ScoredPoint, error) {
	type searchReq struct {
		Vector      []float64     `json:"vector"`
		Limit       int           `json:"limit"`
		WithPayload bool          `json:"with_payload"`
		Filter      *filterClause `json:"filter,omitempty"`
	}

	searchBody := searchReq{
		Vector:      vector,
		Limit:       limit,
		WithPayload: true,
	}

	// Attach a filter that returns admin docs + this user's docs.
	// When userID is empty we skip the filter so all docs are eligible.
	if userID != "" {
		fc := &filterClause{}
		for _, uid := range []string{"admin", userID} {
			cond := struct {
				Key   string `json:"key"`
				Match struct {
					Value string `json:"value"`
				} `json:"match"`
			}{}
			cond.Key = "user_id"
			cond.Match.Value = uid
			fc.Should = append(fc.Should, cond)
		}
		searchBody.Filter = fc
	}

	body, err := json.Marshal(searchBody)
	if err != nil {
		return nil, fmt.Errorf("qdrant: marshal: %w", err)
	}

	endpoint := fmt.Sprintf(
		"%s/collections/%s/points/search",
		q.baseURL,
		url.PathEscape(collection), // handles "Personal Context" → "Personal%20Context"
	)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("qdrant: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := q.http.Do(httpReq)
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
