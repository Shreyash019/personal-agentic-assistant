// admin is a CLI tool for bulk-ingesting topic files into the Qdrant knowledge
// base as the "admin" user.
//
// Usage:
//
//	go run ./cmd/admin -dir ./topics
//	go run ./cmd/admin -dir ./topics -qdrant http://localhost:6333
//
// Every .txt and .md file found directly inside <dir> is read, chunked
// (400-char windows, 50-char overlap), embedded via nomic-embed-text, and
// upserted into the "Personal Context" Qdrant collection with user_id = "admin".
// Files are not recursed — only the top-level directory is processed.
//
// The tool prints a per-file chunk count and a grand total on completion.
// Any file-level error is logged and skipped; ingestion continues for the
// remaining files.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"core-go/internal/agent"
	"core-go/internal/vector"
)

func main() {
	dir := flag.String("dir", "", "Directory containing .txt or .md topic files (required)")
	qdrantURL := flag.String("qdrant", "http://localhost:6333", "Qdrant base URL")
	flag.Parse()

	if *dir == "" {
		fmt.Fprintln(os.Stderr, "error: -dir is required")
		fmt.Fprintln(os.Stderr, "usage: go run ./cmd/admin -dir <directory> [-qdrant <url>]")
		os.Exit(1)
	}

	ctx := context.Background()

	// Ensure the Qdrant collection exists (idempotent).
	qdrantClient := vector.NewQdrantClient(*qdrantURL)
	if err := qdrantClient.EnsureCollection(ctx, agent.CollectionName(), agent.CollectionDim()); err != nil {
		fmt.Fprintf(os.Stderr, "qdrant: ensure collection: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("qdrant: collection %q ready (%d dims)\n\n", agent.CollectionName(), agent.CollectionDim())

	kb := agent.NewKnowledgeBase(qdrantClient)

	entries, err := os.ReadDir(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot read directory %q: %v\n", *dir, err)
		os.Exit(1)
	}

	var (
		totalChunks int
		totalFiles  int
		skipped     int
	)

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext != ".txt" && ext != ".md" {
			continue
		}

		path := filepath.Join(*dir, name)
		content, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  ✗ %-40s  skip: %v\n", name, err)
			skipped++
			continue
		}

		chunks, err := kb.IngestText(ctx, string(content), name, "admin")
		if err != nil {
			fmt.Fprintf(os.Stderr, "  ✗ %-40s  error: %v\n", name, err)
			skipped++
			continue
		}

		fmt.Printf("  ✓ %-40s  %d chunk(s)\n", name, chunks)
		totalChunks += chunks
		totalFiles++
	}

	fmt.Printf("\n─────────────────────────────────────────────────────\n")
	fmt.Printf("Ingested : %d file(s), %d chunk(s) → user_id = \"admin\"\n", totalFiles, totalChunks)
	if skipped > 0 {
		fmt.Printf("Skipped  : %d file(s) (see errors above)\n", skipped)
	}
}
