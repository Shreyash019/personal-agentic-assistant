package agent

import (
	"context"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"core-go/internal/llm"
	"core-go/internal/vector"
)

const (
	ragCollection = "Personal Context"

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

type ragRuntimeConfig struct {
	TopK                int
	FallbackTopK        int
	MaxContextChunks    int
	MinTopSemanticScore float64
	MinSemanticFloor    float64
	MinLexicalScore     float64
	LexicalWeight       float64
	SourceHintWeight    float64
}

var ragCfg = ragRuntimeConfig{
	TopK:                getEnvInt("RAG_TOP_K", 8),
	FallbackTopK:        getEnvInt("RAG_FALLBACK_TOP_K", 80),
	MaxContextChunks:    getEnvInt("RAG_MAX_CONTEXT_CHUNKS", 6),
	MinTopSemanticScore: getEnvFloat("RAG_MIN_TOP_SEMANTIC_SCORE", 0.20),
	MinSemanticFloor:    getEnvFloat("RAG_MIN_SEMANTIC_FLOOR", 0.08),
	MinLexicalScore:     getEnvFloat("RAG_MIN_LEXICAL_SCORE", 0.20),
	LexicalWeight:       getEnvFloat("RAG_LEXICAL_WEIGHT", 0.45),
	SourceHintWeight:    getEnvFloat("RAG_SOURCE_HINT_WEIGHT", 0.20),
}

type rankedPoint struct {
	Point      vector.ScoredPoint
	Semantic   float64
	Lexical    float64
	SourceHint float64
	Hybrid     float64
}

var stopWords = map[string]bool{
	"a": true, "an": true, "and": true, "are": true, "as": true, "at": true,
	"be": true, "by": true, "for": true, "from": true, "how": true, "i": true,
	"in": true, "is": true, "it": true, "of": true, "on": true, "or": true,
	"that": true, "the": true, "this": true, "to": true, "was": true,
	"what": true, "when": true, "where": true, "which": true, "who": true,
	"why": true, "with": true, "you": true, "your": true,
}

const outOfScopeMsg = "I don't have information on that topic."

// systemPromptTmpl enforces a strictly closed domain: the model must respond
// only from the provided CONTEXT and must not use any training knowledge.
// When no relevant context was found the caller returns a static boundary
// message before reaching the LLM — this prompt is only rendered when at
// least one relevant chunk exists.
const systemPromptTmpl = `You are a topic-restricted assistant. You may ONLY answer questions that can be fully answered using the information provided in the CONTEXT section below.

Do NOT use any general knowledge, training data, or information that is not present in the CONTEXT.
If the user's question cannot be answered from the provided context, respond with exactly:
"I don't have information on that topic."

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
	log.Printf("rag: config topK=%d fallbackTopK=%d maxContext=%d minTopSemantic=%.2f minLexical=%.2f",
		ragCfg.TopK,
		ragCfg.FallbackTopK,
		ragCfg.MaxContextChunks,
		ragCfg.MinTopSemanticScore,
		ragCfg.MinLexicalScore,
	)
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

	// Step 2: retrieve primary semantic matches scoped to admin + userID.
	points, err := kb.qdrant.Search(ctx, ragCollection, vec, ragCfg.TopK, userID)
	if err != nil {
		return nil, fmt.Errorf("rag: search: %w", err)
	}
	if len(points) == 0 {
		return staticTextStream(kb.outOfScopeMessage(ctx, userID)), nil
	}

	// Step 3: rank primary candidates with hybrid semantic+lexical scoring.
	ranked := rankPoints(query, points)
	inScope := isInScope(ranked)

	// Step 4: if low-confidence, expand retrieval and re-rank using deeper pool.
	if !inScope && ragCfg.FallbackTopK > ragCfg.TopK {
		fallbackPoints, searchErr := kb.qdrant.Search(ctx, ragCollection, vec, ragCfg.FallbackTopK, userID)
		if searchErr != nil {
			return nil, fmt.Errorf("rag: fallback search: %w", searchErr)
		}
		if len(fallbackPoints) > 0 {
			ranked = rankPoints(query, fallbackPoints)
			inScope = isInScope(ranked)
		}
	}

	if !inScope {
		return staticTextStream(kb.outOfScopeMessage(ctx, userID)), nil
	}

	relevant := selectContextPoints(ranked)
	if len(relevant) == 0 {
		return staticTextStream(kb.outOfScopeMessage(ctx, userID)), nil
	}

	// Step 5: compile system prompt from selected context.
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

func rankPoints(query string, points []vector.ScoredPoint) []rankedPoint {
	queryTokens := tokenizeMeaningful(query)
	if len(points) == 0 {
		return nil
	}

	ranked := make([]rankedPoint, 0, len(points))
	for _, point := range points {
		text, _ := point.Payload["text"].(string)
		source, _ := point.Payload["source"].(string)
		sourceLabel := sourceToTopicLabel(source)

		combined := strings.ToLower(text + " " + sourceLabel)
		combinedTokens := tokenizeMeaningful(combined)

		matched := 0
		for _, queryToken := range queryTokens {
			if hasTokenOrNearMatch(queryToken, combinedTokens) {
				matched++
			}
		}

		lexicalScore := 0.0
		if len(queryTokens) > 0 {
			lexicalScore = float64(matched) / float64(len(queryTokens))
		}

		sourceHint := 0.0
		if hasTokenOrNearMatchInText(queryTokens, tokenizeMeaningful(sourceLabel)) {
			sourceHint = 1.0
		}

		semantic := math.Max(0, point.Score)
		hybrid := semantic + ragCfg.LexicalWeight*lexicalScore + ragCfg.SourceHintWeight*sourceHint

		ranked = append(ranked, rankedPoint{
			Point:      point,
			Semantic:   semantic,
			Lexical:    lexicalScore,
			SourceHint: sourceHint,
			Hybrid:     hybrid,
		})
	}

	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].Hybrid == ranked[j].Hybrid {
			return ranked[i].Semantic > ranked[j].Semantic
		}
		return ranked[i].Hybrid > ranked[j].Hybrid
	})

	return ranked
}

func isInScope(ranked []rankedPoint) bool {
	if len(ranked) == 0 {
		return false
	}
	top := ranked[0]
	if top.Semantic >= ragCfg.MinTopSemanticScore {
		return true
	}
	if top.Lexical >= ragCfg.MinLexicalScore {
		return true
	}
	if top.SourceHint > 0 && top.Lexical > 0 {
		return true
	}
	return false
}

func selectContextPoints(ranked []rankedPoint) []vector.ScoredPoint {
	if len(ranked) == 0 {
		return nil
	}

	limit := ragCfg.MaxContextChunks
	if limit <= 0 {
		limit = 4
	}

	out := make([]vector.ScoredPoint, 0, limit)
	for _, item := range ranked {
		if len(out) >= limit {
			break
		}
		if item.Semantic >= ragCfg.MinSemanticFloor || item.Lexical > 0 || item.SourceHint > 0 {
			out = append(out, item.Point)
		}
	}

	if len(out) == 0 {
		out = append(out, ranked[0].Point)
	}

	return out
}

func hasTokenOrNearMatchInText(queryTokens []string, candidateTokens []string) bool {
	for _, queryToken := range queryTokens {
		if hasTokenOrNearMatch(queryToken, candidateTokens) {
			return true
		}
	}
	return false
}

func hasTokenOrNearMatch(queryToken string, candidateTokens []string) bool {
	for _, candidate := range candidateTokens {
		if candidate == queryToken {
			return true
		}
		if isNearToken(queryToken, candidate) {
			return true
		}
	}
	return false
}

func isNearToken(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	if len(a) < 5 || len(b) < 5 {
		return false
	}
	diff := len(a) - len(b)
	if diff > 1 || diff < -1 {
		return false
	}
	return editDistanceAtMostOne(a, b)
}

func editDistanceAtMostOne(a, b string) bool {
	i := 0
	j := 0
	edits := 0

	for i < len(a) && j < len(b) {
		if a[i] == b[j] {
			i++
			j++
			continue
		}

		edits++
		if edits > 1 {
			return false
		}

		if len(a) > len(b) {
			i++
		} else if len(a) < len(b) {
			j++
		} else {
			i++
			j++
		}
	}

	if i < len(a) || j < len(b) {
		edits++
	}

	return edits <= 1
}

func getEnvInt(key string, defaultValue int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return defaultValue
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return defaultValue
	}
	return v
}

func getEnvFloat(key string, defaultValue float64) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return defaultValue
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return defaultValue
	}
	return v
}

func tokenizeMeaningful(text string) []string {
	norm := strings.ToLower(text)
	replacer := strings.NewReplacer(
		".", " ", ",", " ", ";", " ", ":", " ", "!", " ", "?", " ",
		"(", " ", ")", " ", "[", " ", "]", " ", "{", " ", "}", " ",
		"\"", " ", "'", " ", "-", " ", "_", " ", "\n", " ", "\t", " ",
	)
	norm = replacer.Replace(norm)
	parts := strings.Fields(norm)
	tokens := make([]string, 0, len(parts))
	for _, part := range parts {
		if len(part) < 3 {
			continue
		}
		if stopWords[part] {
			continue
		}
		tokens = append(tokens, part)
	}
	return tokens
}

func hasLexicalGrounding(query string, points []vector.ScoredPoint) bool {
	queryTokens := tokenizeMeaningful(query)
	if len(queryTokens) == 0 {
		return true
	}

	var contextBuilder strings.Builder
	for _, p := range points {
		text, _ := p.Payload["text"].(string)
		if text == "" {
			continue
		}
		if contextBuilder.Len() > 0 {
			contextBuilder.WriteString(" ")
		}
		contextBuilder.WriteString(strings.ToLower(text))
	}
	contextText := contextBuilder.String()
	if contextText == "" {
		return false
	}

	for _, token := range queryTokens {
		if strings.Contains(contextText, token) {
			return true
		}
	}
	return false
}

func hasSourceTopicHint(query string, points []vector.ScoredPoint) bool {
	queryTokens := tokenizeMeaningful(query)
	if len(queryTokens) == 0 {
		return false
	}

	topicTokenSet := map[string]bool{}
	for _, point := range points {
		source, _ := point.Payload["source"].(string)
		if source == "" {
			continue
		}
		label := sourceToTopicLabel(source)
		for _, token := range tokenizeMeaningful(label) {
			topicTokenSet[token] = true
		}
	}

	if len(topicTokenSet) == 0 {
		return false
	}

	for _, token := range queryTokens {
		if topicTokenSet[token] {
			return true
		}
	}
	return false
}

func sourceToTopicLabel(source string) string {
	base := strings.TrimSpace(source)
	if base == "" {
		return ""
	}
	base = filepath.Base(base)
	ext := filepath.Ext(base)
	if ext != "" {
		base = strings.TrimSuffix(base, ext)
	}
	base = strings.ReplaceAll(base, "_", " ")
	base = strings.ReplaceAll(base, "-", " ")
	base = strings.TrimSpace(base)
	if base == "" {
		return ""
	}
	words := strings.Fields(strings.ToLower(base))
	for i, word := range words {
		if len(word) == 0 {
			continue
		}
		words[i] = strings.ToUpper(word[:1]) + word[1:]
	}
	return strings.Join(words, " ")
}

func (kb *KnowledgeBase) outOfScopeMessage(ctx context.Context, userID string) string {
	_ = ctx
	_ = userID
	return outOfScopeMsg
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

// ReconstructText rebuilds the original document text from an ordered slice
// of chunk strings. It strips the leading chunkOverlap runes from every chunk
// after the first, reversing the sliding-window overlap added during ingestion.
// The result is a close approximation of the original; minor whitespace
// differences may exist because chunkText applies TrimSpace to each chunk.
func ReconstructText(chunks []string) string {
	if len(chunks) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(chunks[0])
	for _, c := range chunks[1:] {
		runes := []rune(c)
		skip := chunkOverlap
		if skip > len(runes) {
			skip = len(runes)
		}
		if skip < len(runes) {
			sb.WriteString(string(runes[skip:]))
		}
	}
	return sb.String()
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
