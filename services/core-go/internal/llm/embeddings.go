package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const (
	ollamaEmbedURL  = "http://localhost:11434/api/embeddings"
	embeddingModel  = "nomic-embed-text"
	clientTimeout   = 30 * time.Second
)

// embedRequest is the JSON body sent to Ollama.
type embedRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
}

// embedResponse is the JSON body returned by Ollama.
type embedResponse struct {
	Embedding []float64 `json:"embedding"`
}

// httpClient is reused across calls for connection pooling.
// The 30s Timeout acts as a hard backstop; a context deadline on the
// incoming ctx will fire first if it is shorter.
var httpClient = &http.Client{Timeout: clientTimeout}

// Embed sends text to the local Ollama instance and returns the raw
// embedding vector produced by nomic-embed-text (768 dimensions).
//
// Timeout behaviour:
//   - ctx cancellation / deadline takes effect immediately via the request context.
//   - The package-level http.Client.Timeout (30s) is a defensive backstop for
//     callers that pass context.Background().
func Embed(ctx context.Context, text string) ([]float64, error) {
	body, err := json.Marshal(embedRequest{Model: embeddingModel, Prompt: text})
	if err != nil {
		return nil, fmt.Errorf("embed: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ollamaEmbedURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("embed: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embed: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("embed: ollama status %d", resp.StatusCode)
	}

	var result embedResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("embed: decode: %w", err)
	}

	if len(result.Embedding) == 0 {
		return nil, fmt.Errorf("embed: empty vector returned by ollama")
	}

	return result.Embedding, nil
}
