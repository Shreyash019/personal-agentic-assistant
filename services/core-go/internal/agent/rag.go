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
)

// systemPromptTmpl is intentionally strict: the model must answer only from
// the supplied context and must not fabricate information.
const systemPromptTmpl = `You are a personal knowledge assistant with access to the user's private notes and documents.

Answer the user's question using ONLY the information provided in the CONTEXT section below.
Do NOT draw on any knowledge outside of that context.
If the context does not contain enough information to answer, respond exactly with:
"I don't have enough information about that in my knowledge base."

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

// AskKnowledgeBase runs the full RAG pipeline for query and returns a
// read-only channel of streaming LLM chunks.
//
//  1. Vectorises query via Ollama nomic-embed-text.
//  2. Retrieves the top-3 nearest chunks from the "Personal Context" collection.
//  3. Compiles a strict system prompt from the retrieved context.
//  4. Streams the LLM response via llama3.1:8b (no tools — pure Q&A).
//
// The returned channel is closed when the stream ends or ctx is cancelled.
func (kb *KnowledgeBase) AskKnowledgeBase(ctx context.Context, query string) (<-chan llm.Chunk, error) {
	// Step 1: embed the query.
	vec, err := llm.Embed(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("rag: embed: %w", err)
	}

	// Step 2: retrieve top-3 semantic matches.
	points, err := kb.qdrant.Search(ctx, ragCollection, vec, ragTopK)
	if err != nil {
		return nil, fmt.Errorf("rag: search: %w", err)
	}

	// Step 3: compile system prompt from retrieved context.
	systemPrompt := buildSystemPrompt(points)

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

// buildSystemPrompt formats the retrieved ScoredPoints into the strict
// system prompt template. Each chunk is numbered [1]–[N].
func buildSystemPrompt(points []vector.ScoredPoint) string {
	if len(points) == 0 {
		return fmt.Sprintf(systemPromptTmpl, "(no relevant context found)")
	}

	var sb strings.Builder
	for i, p := range points {
		text, _ := p.Payload["text"].(string)
		if text == "" {
			text = "(empty chunk)"
		}
		if i > 0 {
			sb.WriteString("\n\n")
		}
		fmt.Fprintf(&sb, "[%d] %s", i+1, text)
	}

	return fmt.Sprintf(systemPromptTmpl, sb.String())
}
