// TGIF GIF Picker - Ingestion Script
// Imports TGIF dataset into Antfly with CLIP embeddings
//
// This version calls Termite's multimodal API directly to compute image
// embeddings, bypassing the broken Antfly integration. It uses the
// _embeddings field to store precomputed vectors.
//
// Prerequisites:
// - Antfly running: antfly swarm
// - CLIP model: antflycli termite pull openai/clip-vit-base-patch32
//
// Run: go run main.go

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/md5"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/antflydb/antfly-go/antfly"
)

var (
	antflyURL   = flag.String("url", "http://localhost:8080/api/v1", "Antfly API URL")
	termiteURL  = flag.String("termite-url", "http://localhost:11433", "Termite API URL")
	tsvPath     = flag.String("tsv", "../TGIF-Release/data/tgif-v1.0.tsv", "Path to TGIF TSV file")
	tableName   = flag.String("table", "tgif_gifs", "Antfly table name")
	batchSize   = flag.Int("batch", 10, "Batch size for inserts (smaller due to embedding calls)")
	limit       = flag.Int("limit", 0, "Limit number of GIFs to import (0 = all)")
	skipCreate  = flag.Bool("skip-create", false, "Skip table creation")
	clipModel   = flag.String("clip-model", "openai/clip-vit-base-patch32", "CLIP model for embeddings")
)

// tumblrIDRegex extracts the tumblr ID from a GIF URL
var tumblrIDRegex = regexp.MustCompile(`tumblr_([a-zA-Z0-9]+)`)

// httpClient with timeout for Termite requests
var httpClient = &http.Client{Timeout: 60 * time.Second}

// getImageEmbedding calls Termite's multimodal API directly to embed an image URL
func getImageEmbedding(ctx context.Context, imageURL string) ([]float32, error) {
	// Build multimodal embed request
	// Format: {"model": "...", "input": [{"type": "image_url", "image_url": {"url": "..."}}]}
	reqBody := map[string]any{
		"model": *clipModel,
		"input": []map[string]any{
			{
				"type": "image_url",
				"image_url": map[string]string{
					"url": imageURL,
				},
			},
		},
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", *termiteURL+"/api/embed", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("termite error %d: %s", resp.StatusCode, string(body))
	}

	// Response is binary: uint64(numVectors) + uint64(dimension) + float32 values
	return deserializeEmbedding(body)
}

// deserializeEmbedding parses Termite's binary embedding response
func deserializeEmbedding(data []byte) ([]float32, error) {
	r := bytes.NewReader(data)

	var numVectors uint64
	if err := binary.Read(r, binary.LittleEndian, &numVectors); err != nil {
		return nil, fmt.Errorf("read numVectors: %w", err)
	}
	if numVectors == 0 {
		return nil, fmt.Errorf("no embeddings returned")
	}

	var dimension uint64
	if err := binary.Read(r, binary.LittleEndian, &dimension); err != nil {
		return nil, fmt.Errorf("read dimension: %w", err)
	}

	embedding := make([]float32, dimension)
	for i := range embedding {
		if err := binary.Read(r, binary.LittleEndian, &embedding[i]); err != nil {
			return nil, fmt.Errorf("read float %d: %w", i, err)
		}
	}

	return embedding, nil
}

func main() {
	flag.Parse()
	ctx := context.Background()

	// Create client
	client, err := antfly.NewAntflyClient(*antflyURL, http.DefaultClient)
	if err != nil {
		log.Fatalf("Failed to create client: %v", err)
	}

	// Create table with CLIP embeddings index
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
	fmt.Printf("Creating table '%s' with CLIP embeddings index (precomputed vectors)...\n", *tableName)

	// Use direct HTTP request with correct API format (no nested wrappers)
	// This avoids any potential SDK quirks
	reqBody := fmt.Sprintf(`{
		"indexes": {
			"embeddings": {
				"name": "embeddings",
				"type": "aknn_v0",
				"dimension": 512
			}
		}
	}`)

	req, err := http.NewRequestWithContext(ctx, "POST",
		strings.TrimSuffix(*antflyURL, "/api/v1")+"/api/v1/tables/"+*tableName,
		strings.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusConflict || strings.Contains(string(body), "already exists") {
		fmt.Printf("Table '%s' already exists, continuing...\n", *tableName)
		return nil
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("create table failed %d: %s", resp.StatusCode, string(body))
	}

	fmt.Printf("Created table '%s'\n", *tableName)

	// Wait for shards to be ready (with extra buffer time)
	if err := waitForShards(ctx, client, 30*time.Second); err != nil {
		return err
	}
	// Longer wait to avoid race conditions with shard startup
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
	file, err := os.Open(*tsvPath)
	if err != nil {
		return fmt.Errorf("open tsv: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	batch := make(map[string]any)
	imported := 0
	skipped := 0
	embedFailed := 0
	startTime := time.Now()

	fmt.Println("Starting import with direct CLIP image embeddings...")
	fmt.Printf("Termite URL: %s, Model: %s\n", *termiteURL, *clipModel)

	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			skipped++
			continue
		}

		gifURL := fixTumblrURL(parts[0])
		description := parts[1]
		tumblrID := extractTumblrID(gifURL)

		// Get image embedding from Termite
		embedding, err := getImageEmbedding(ctx, gifURL)
		if err != nil {
			log.Printf("Warning: failed to embed %s: %v", gifURL, err)
			embedFailed++
			continue
		}

		// Generate document ID from URL hash
		hash := md5.Sum([]byte(gifURL))
		docID := fmt.Sprintf("gif_%x", hash[:8])

		// Convert []float32 to []any for JSON
		embeddingAny := make([]any, len(embedding))
		for i, v := range embedding {
			embeddingAny[i] = v
		}

		batch[docID] = map[string]any{
			"gif_url":     gifURL,
			"description": description,
			"tumblr_id":   tumblrID,
			"_embeddings": map[string]any{
				"embeddings": embeddingAny, // matches index name
			},
		}

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
			fmt.Printf("\rImported: %d (%.1f/sec, %d embed failures)", imported, rate, embedFailed)

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
	fmt.Printf("\nCompleted: %d GIFs in %.1fs (%.1f/sec), %d skipped, %d embed failures\n",
		imported, elapsed, float64(imported)/elapsed, skipped, embedFailed)

	return scanner.Err()
}

func flushBatch(ctx context.Context, client *antfly.AntflyClient, batch map[string]any) error {
	_, err := client.Batch(ctx, *tableName, antfly.BatchRequest{
		Inserts: batch,
	})
	return err
}

// fixTumblrURL updates old Tumblr CDN URLs to the new domain
func fixTumblrURL(url string) string {
	// Old CDN domains redirect to 64.media.tumblr.com
	url = strings.Replace(url, "38.media.tumblr.com", "64.media.tumblr.com", 1)
	url = strings.Replace(url, "33.media.tumblr.com", "64.media.tumblr.com", 1)
	url = strings.Replace(url, "31.media.tumblr.com", "64.media.tumblr.com", 1)
	return url
}

// extractTumblrID extracts the tumblr post ID from a GIF URL
func extractTumblrID(url string) string {
	matches := tumblrIDRegex.FindStringSubmatch(url)
	if len(matches) >= 2 {
		return matches[1]
	}
	return ""
}
