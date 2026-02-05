// TGIF GIF Picker - Text Embeddings Ingestion Script
// Imports GIF descriptions (from Gemini) into Antfly with text embeddings
//
// This version uses text embeddings on the enriched descriptions from
// describe_gifs.py. Antfly's built-in termite handles embedding automatically
// via the configured Embedder on the index (no direct termite calls).
//
// Prerequisites:
// - Antfly running: antfly swarm
// - Text embedding model: antflycli termite pull BAAI/bge-small-en-v1.5 --type embedder
// - Description file: gif_descriptions.jsonl (from describe_gifs.py)
//
// Run: go run ingest_text.go

package main

import (
	"bufio"
	"context"
	"crypto/md5"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/antflydb/antfly-go/antfly"
	"github.com/antflydb/antfly-go/antfly/oapi"
)

var (
	antflyURL   = flag.String("url", "http://localhost:8080/api/v1", "Antfly API URL")
	jsonlPath   = flag.String("jsonl", "../gif_descriptions.jsonl", "Path to descriptions JSONL file")
	tableName   = flag.String("table", "tgif_gifs_text", "Antfly table name")
	batchSize   = flag.Int("batch", 50, "Batch size for inserts")
	limit       = flag.Int("limit", 0, "Limit number of GIFs to import (0 = all)")
	skipCreate  = flag.Bool("skip-create", false, "Skip table creation")
	embedModel  = flag.String("embed-model", "BAAI/bge-small-en-v1.5", "Text embedding model")
	dimension   = flag.Int("dimension", 384, "Embedding dimension (384 for bge-small)")
	attribution = flag.String("attribution", "", "Default attribution for docs missing one (e.g., 'TGIF dataset')")
)

// GIFDescription matches the output of describe_gifs.py and describe_sources.py
type GIFDescription struct {
	ID                  string          `json:"id"`          // Optional: manifest ID (used as doc ID if present)
	URL                 string          `json:"url"`
	Attribution         string          `json:"attribution"` // Optional: source page URL for credit
	OriginalDescription string          `json:"original_description"`
	Literal             string          `json:"literal"`
	Source              string          `json:"source"`
	Mood                string          `json:"mood"`
	Action              json.RawMessage `json:"action"` // Can be string or []string
	Context             string          `json:"context"`
	Tags                []string        `json:"tags"`
}

// DocID returns the document ID, preferring the manifest ID if present.
func (g *GIFDescription) DocID() string {
	if g.ID != "" {
		return g.ID
	}
	hash := md5.Sum([]byte(g.URL))
	return fmt.Sprintf("gif_%x", hash[:8])
}

// ActionString returns the action as a string (handles both string and array)
func (g *GIFDescription) ActionString() string {
	// Try as string first
	var s string
	if err := json.Unmarshal(g.Action, &s); err == nil {
		return s
	}
	// Try as array
	var arr []string
	if err := json.Unmarshal(g.Action, &arr); err == nil {
		return strings.Join(arr, ", ")
	}
	return ""
}

// CombinedText creates a searchable text blob from all description fields
func (g *GIFDescription) CombinedText() string {
	parts := []string{
		g.Literal,
		"Source: " + g.Source,
		"Mood: " + g.Mood,
		"Actions: " + g.ActionString(),
		"Use case: " + g.Context,
		"Tags: " + strings.Join(g.Tags, ", "),
	}
	return strings.Join(parts, ". ")
}

func main() {
	flag.Parse()
	ctx := context.Background()

	// Create client
	client, err := antfly.NewAntflyClient(*antflyURL, http.DefaultClient)
	if err != nil {
		log.Fatalf("Failed to create client: %v", err)
	}

	// Create table with text embeddings index
	if !*skipCreate {
		if err := createTable(ctx, client); err != nil {
			log.Fatalf("Failed to create table: %v", err)
		}
	}

	// Import GIFs
	if err := importGIFs(ctx, client); err != nil {
		log.Fatalf("Failed to import GIFs: %v", err)
	}
}

func createTable(ctx context.Context, client *antfly.AntflyClient) error {
	fmt.Printf("Creating table '%s' with text embeddings index (dim=%d)...\n", *tableName, *dimension)

	// Build the embedder config (union type)
	var embedderConfig oapi.EmbedderConfig
	embedderConfig.Provider = oapi.EmbedderProviderTermite
	embedderConfig.FromTermiteEmbedderConfig(oapi.TermiteEmbedderConfig{
		Model: *embedModel,
	})

	// Build the index config (union type)
	var indexConfig oapi.IndexConfig
	indexConfig.Name = "embeddings"
	indexConfig.Type = oapi.IndexTypeAknnV0
	indexConfig.FromEmbeddingIndexConfig(oapi.EmbeddingIndexConfig{
		Dimension: *dimension,
		Embedder:  embedderConfig,
		Field:     "combined_text",
	})

	err := client.CreateTable(ctx, *tableName, antfly.CreateTableRequest{
		Indexes: map[string]oapi.IndexConfig{
			"embeddings": indexConfig,
		},
	})
	if err != nil {
		if strings.Contains(err.Error(), "already exists") {
			fmt.Printf("Table '%s' already exists, continuing...\n", *tableName)
			return nil
		}
		return fmt.Errorf("create table: %w", err)
	}

	fmt.Printf("Created table '%s'\n", *tableName)

	// Wait for shards to be ready
	if err := waitForShards(ctx, client, 30*time.Second); err != nil {
		return err
	}
	fmt.Println("Waiting 30s for shard stability...")
	time.Sleep(30 * time.Second)
	return nil
}

func waitForShards(ctx context.Context, client *antfly.AntflyClient, timeout time.Duration) error {
	fmt.Println("Waiting for shards to be ready...")
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	pollCount := 0
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			pollCount++
			if time.Now().After(deadline) {
				return fmt.Errorf("timeout waiting for shards")
			}

			status, err := client.GetTable(ctx, *tableName)
			if err != nil {
				continue
			}

			if len(status.Shards) > 0 && pollCount >= 6 {
				fmt.Printf("Shards ready after %d polls\n", pollCount)
				return nil
			}
		}
	}
}

func importGIFs(ctx context.Context, client *antfly.AntflyClient) error {
	file, err := os.Open(*jsonlPath)
	if err != nil {
		return fmt.Errorf("open jsonl: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	// Increase buffer for large JSON lines
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	batch := make(map[string]any)
	imported := 0
	startTime := time.Now()

	fmt.Println("Starting import (Antfly's termite will compute embeddings)...")
	fmt.Printf("Model: %s, Field: combined_text\n", *embedModel)

	for scanner.Scan() {
		var desc GIFDescription
		if err := json.Unmarshal(scanner.Bytes(), &desc); err != nil {
			log.Printf("Warning: failed to parse line: %v", err)
			continue
		}

		// Create combined text for embedding (Antfly will embed this via the configured Field)
		text := desc.CombinedText()

		// Generate document ID (prefers manifest ID if present)
		docID := desc.DocID()

		doc := map[string]any{
			"gif_url":              desc.URL,
			"original_description": desc.OriginalDescription,
			"literal":              desc.Literal,
			"source":               desc.Source,
			"mood":                 desc.Mood,
			"action":               desc.Action,
			"context":              desc.Context,
			"tags":                 desc.Tags,
			"combined_text":        text,
		}
		if desc.Attribution != "" {
			doc["attribution"] = desc.Attribution
		} else if *attribution != "" {
			doc["attribution"] = *attribution
		}
		batch[docID] = doc

		// Flush batch
		if len(batch) >= *batchSize {
			if err := flushBatch(ctx, client, batch); err != nil {
				log.Printf("Warning: batch insert failed: %v", err)
			}
			imported += len(batch)
			batch = make(map[string]any)

			// Progress report
			elapsed := time.Since(startTime).Seconds()
			rate := float64(imported) / elapsed
			fmt.Printf("\rImported: %d (%.1f/sec)", imported, rate)

			// Check limit
			if *limit > 0 && imported >= *limit {
				fmt.Printf("\nReached limit of %d\n", *limit)
				break
			}
		}
	}

	// Final batch
	if len(batch) > 0 {
		if err := flushBatch(ctx, client, batch); err != nil {
			log.Printf("Warning: final batch insert failed: %v", err)
		}
		imported += len(batch)
	}

	elapsed := time.Since(startTime).Seconds()
	fmt.Printf("\nCompleted: %d GIFs in %.1fs (%.1f/sec)\n",
		imported, elapsed, float64(imported)/elapsed)

	return scanner.Err()
}

func flushBatch(ctx context.Context, client *antfly.AntflyClient, batch map[string]any) error {
	_, err := client.Batch(ctx, *tableName, antfly.BatchRequest{
		Inserts: batch,
	})
	return err
}
