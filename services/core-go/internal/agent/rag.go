package agent

import (
	"context"
	"fmt"
	"strings"

	"core-go/internal/llm"
	"core-go/internal/vector"
)

const (
	ragCollection = "Personal Context"
	ragTopK       = 3

	// ragScoreThreshold is the minimum cosine similarity score a retrieved
	// chunk must have to be included in the LLM context. Chunks below this
	// threshold are semantically too distant from the query to be useful and
	// would only introduce noise. Cosine similarity on normalised vectors
	// ranges from 0 (orthogonal) to 1 (identical).
	ragScoreThreshold = 0.30

	// chunkSize is the maximum number of Unicode code points per text chunk.
	// ~400 characters ≈ 80–100 tokens, well within nomic-embed-text's 8192-
	// token context window while keeping chunks focused enough for retrieval.
	chunkSize = 400

	// chunkOverlap is the number of code points shared between adjacent chunks.
	// Overlap preserves sentence context at chunk boundaries so that a sentence
	// split across two chunks is still fully represented in one of them.
	chunkOverlap = 50

	// ragVectorDim must match the dimension that nomic-embed-text outputs.
	// Changing this requires recreating the Qdrant collection.
	ragVectorDim = 768
)

// systemPromptTmpl enforces a strictly closed domain: the model must respond
// only from the provided CONTEXT and must not use any training knowledge.
// When no relevant context was found the caller returns a static boundary
// message before reaching the LLM — this prompt is only rendered when at
// least one relevant chunk exists.
const systemPromptTmpl = `You are a topic-restricted assistant. You may ONLY answer questions that can be fully answered using the information provided in the CONTEXT section below.

Do NOT use any general knowledge, training data, or information that is not present in the CONTEXT.
If the user's question cannot be answered from the provided context, respond with exactly:
"This question is outside my knowledge boundary. I can only answer questions based on the topics I have been configured with."

CONTEXT:
%s

Answer concisely and directly.`

// KnowledgeBase orchestrates the full RAG pipeline:
// embed → vector search → prompt assembly → streaming LLM response.
type KnowledgeBase struct {
	qdrant *vector.QdrantClient
}

// NewKnowledgeBase returns a KnowledgeBase backed by the given Qdrant client.
func NewKnowledgeBase(qdrant *vector.QdrantClient) *KnowledgeBase {
	return &KnowledgeBase{qdrant: qdrant}
}

// staticTextStream returns a closed channel pre-loaded with a single text
// chunk. Used to emit a static boundary message without invoking the LLM.
func staticTextStream(text string) <-chan llm.Chunk {
	ch := make(chan llm.Chunk, 1)
	ch <- llm.Chunk{Kind: llm.KindText, Text: text}
	close(ch)
	return ch
}

// AskKnowledgeBase runs the full RAG pipeline for query and returns a
// read-only channel of streaming LLM chunks.
//
// userID scopes retrieval to admin documents (shared knowledge base) plus
// documents ingested by this specific user. Pass "admin" to retrieve only
// shared documents, or empty string for unfiltered access.
//
//  1. Vectorises query via Ollama nomic-embed-text.
//  2. Retrieves the top-k nearest chunks scoped to admin + userID.
//  3. Filters out chunks below ragScoreThreshold.
//  4. Compiles a strict system prompt from the filtered context.
//  5. Streams the LLM response via llama3.1:8b (no tools — pure Q&A).
//
// The returned channel is closed when the stream ends or ctx is cancelled.
func (kb *KnowledgeBase) AskKnowledgeBase(ctx context.Context, query, userID string) (<-chan llm.Chunk, error) {
	// Step 1: embed the query.
	vec, err := llm.Embed(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("rag: embed: %w", err)
	}

	// Step 2: retrieve top-k semantic matches scoped to admin + userID.
	points, err := kb.qdrant.Search(ctx, ragCollection, vec, ragTopK, userID)
	if err != nil {
		return nil, fmt.Errorf("rag: search: %w", err)
	}

	// Step 3a: drop chunks whose cosine similarity is below the threshold.
	// Low-scoring chunks are semantically distant from the query; including
	// them adds noise and can cause the model to surface irrelevant content.
	relevant := make([]vector.ScoredPoint, 0, len(points))
	for _, p := range points {
		if p.Score >= ragScoreThreshold {
			relevant = append(relevant, p)
		}
	}

	// Step 3b: if nothing passed the threshold the question is outside the
	// configured topic boundary — return a static message immediately without
	// calling the LLM (saves latency and avoids hallucination risk).
	if len(relevant) == 0 {
		return staticTextStream(
			"This question is outside my knowledge boundary. " +
				"I can only answer questions based on the topics I have been configured with.",
		), nil
	}

	// Step 3c: compile system prompt from the filtered context.
	systemPrompt := buildSystemPrompt(relevant)

	// Step 4: stream LLM response — no tools, this is pure retrieval Q&A.
	messages := []llm.Message{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: query},
	}
	ch, err := llm.StreamChat(ctx, messages, nil)
	if err != nil {
		return nil, fmt.Errorf("rag: stream: %w", err)
	}

	return ch, nil
}

// CollectionDim returns the vector dimension this KnowledgeBase was configured
// with. Called by main to pass the right value to EnsureCollection.
func CollectionDim() int { return ragVectorDim }

// CollectionName returns the Qdrant collection name used by this KnowledgeBase.
func CollectionName() string { return ragCollection }

// IngestText chunks text, embeds each chunk via nomic-embed-text, and upserts
// the resulting vectors into the "Personal Context" Qdrant collection.
//
// userID tags every chunk so retrieval can be scoped per-user. Use "admin"
// for shared knowledge documents accessible by all users.
// source is an arbitrary provenance label (e.g. "notes.txt").
//
// Returns the number of chunks successfully upserted.
func (kb *KnowledgeBase) IngestText(ctx context.Context, text, source, userID string) (int, error) {
	chunks := chunkText(text, chunkSize, chunkOverlap)
	if len(chunks) == 0 {
		return 0, nil
	}

	points := make([]vector.PointInput, 0, len(chunks))
	for i, chunk := range chunks {
		vec, err := llm.Embed(ctx, chunk)
		if err != nil {
			return 0, fmt.Errorf("rag: ingest: embed chunk %d: %w", i, err)
		}
		points = append(points, vector.PointInput{
			ID:     vector.NewPointID(),
			Vector: vec,
			Payload: map[string]any{
				"text":        chunk,
				"source":      source,
				"user_id":     userID,
				"chunk_index": i,
			},
		})
	}

	if err := kb.qdrant.UpsertPoints(ctx, ragCollection, points); err != nil {
		return 0, fmt.Errorf("rag: ingest: upsert: %w", err)
	}
	return len(points), nil
}

// chunkText splits text into overlapping windows of size code points with
// overlap code points of shared context between adjacent chunks.
// It operates on Unicode code points (runes) so multibyte characters are
// never split mid-sequence.
func chunkText(text string, size, overlap int) []string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) == 0 {
		return nil
	}
	step := size - overlap
	if step <= 0 {
		step = 1 // guard against misconfiguration
	}
	var chunks []string
	for start := 0; start < len(runes); start += step {
		end := start + size
		if end > len(runes) {
			end = len(runes)
		}
		chunk := strings.TrimSpace(string(runes[start:end]))
		if chunk != "" {
			chunks = append(chunks, chunk)
		}
		if end >= len(runes) {
			break
		}
	}
	return chunks
}

// buildSystemPrompt formats the retrieved ScoredPoints into the strict
// system prompt template. Each chunk is numbered [1]–[N].
func buildSystemPrompt(points []vector.ScoredPoint) string {
	var sb strings.Builder
	idx := 1

	for _, p := range points {
		text, _ := p.Payload["text"].(string)
		if text == "" {
			text = "(empty chunk)"
		}
		if sb.Len() > 0 {
			sb.WriteString("\n\n")
		}
		fmt.Fprintf(&sb, "[%d] %s", idx, text)
		idx++
	}

	// No built-in fallback knowledge — the admin must ingest all topic files.
	// An empty context here should not occur because AskKnowledgeBase returns
	// a static boundary message before calling buildSystemPrompt when there
	// are no relevant chunks; this guard is a safety net only.
	if sb.Len() == 0 {
		sb.WriteString("(no relevant context found)")
	}

	return fmt.Sprintf(systemPromptTmpl, sb.String())
}
