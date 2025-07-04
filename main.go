// main.go
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

// -----------------------------------------------------------------------------
//  GLOBALS
// -----------------------------------------------------------------------------

var settings Settings

// -----------------------------------------------------------------------------
//  MAIN
// -----------------------------------------------------------------------------

func main() {
	// 1) config
	settings = loadSettings()
	if err := godotenv.Load(); err != nil {
		log.Fatal("error loading .env file")
	}

	// 2) routes
	http.Handle("/", http.FileServer(http.Dir("static")))
	http.HandleFunc("/api/settings", settingsHandler)
	http.HandleFunc("/api/generate-summaries", generateSummariesHandler)
	http.HandleFunc("/api/run-grok-prompts", runGrokPromptsHandler)
	http.HandleFunc("/api/run-pplx-queries", runPPLXQueriesHandler)

	// 3) server
	go func() {
		log.Println("➜ Serving on http://localhost:8080 …")
		log.Fatal(http.ListenAndServe(":8080", nil))
	}()

	time.Sleep(time.Second)
	_ = exec.Command("google-chrome", "http://localhost:8080").Start()

	select {} // keep alive
}

// -----------------------------------------------------------------------------
//  SETTINGS ENDPOINT
// -----------------------------------------------------------------------------

func settingsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		out, err := yaml.Marshal(settings)
		if err != nil {
			http.Error(w, "error marshalling settings", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Write(out)

	case http.MethodPost:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "error reading body", http.StatusBadRequest)
			return
		}
		var s Settings
		if err := yaml.Unmarshal(body, &s); err != nil {
			http.Error(w, "invalid YAML", http.StatusBadRequest)
			return
		}
		if err := saveSettings(s); err != nil {
			http.Error(w, "error saving settings", http.StatusInternalServerError)
			return
		}
		settings = s
		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// -----------------------------------------------------------------------------
//  NEWS  ➜   **OpenAI / GPT-4o**
// -----------------------------------------------------------------------------

func generateSummariesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	fullPrompt := settings.NewsPrompt + "\n\n" + req.Email
	log.Printf("📰  /api/generate-summaries – prompt length %d bytes", len(fullPrompt))

	// -------------------------------------------------------------------------
	//  Begin HTTP-streaming response to the browser
	// -------------------------------------------------------------------------
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	sendJSONLine := func(v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "%s\n", b)
		flusher.Flush()
	}

	sendJSONLine(map[string]string{
		"type":    "prompt",
		"content": "Generating summaries…",
	})

	// -------------------------------------------------------------------------
	//  Call OpenAI and relay the chunks straight to the browser
	// -------------------------------------------------------------------------
	if err := streamOpenAIAPI(w, flusher, fullPrompt); err != nil {
		sendJSONLine(map[string]string{
			"type":    "error",
			"content": err.Error(),
		})
	}

	sendJSONLine(map[string]string{"type": "end"})
}

func streamOpenAIAPI(w io.Writer, flusher http.Flusher, prompt string) error {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return fmt.Errorf("OPENAI_API_KEY not set")
	}

	payload := map[string]any{
		"model": "gpt-4o",
		"messages": []map[string]string{
			{"role": "system", "content": "You are a concise news-summary assistant."},
			{"role": "user", "content": prompt},
		},
		"stream": true,
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(
		http.MethodPost,
		"https://api.openai.com/v1/chat/completions",
		bytes.NewBuffer(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("OpenAI error %d – %s", resp.StatusCode, string(b))
	}

	reader := bufio.NewReader(resp.Body)

	for {
		line, err := reader.ReadString('\n')
		switch {
		case err == io.EOF:
			return nil
		case err != nil:
			return err
		case !strings.HasPrefix(line, "data: "):
			continue
		}

		data := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
		if data == "[DONE]" {
			return nil
		}

		var ev struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			log.Println("⚠️  OpenAI stream parse error:", err)
			continue
		}

		if c := ev.Choices[0].Delta.Content; c != "" {
			out, _ := json.Marshal(map[string]string{
				"type":    "chunk",
				"content": c,
			})
			fmt.Fprintf(w, "%s\n", out)
			flusher.Flush()

			if len(c) > 0 {
				runes := []rune(c)
				preview := string(runes)
				if len(runes) > 60 {
					preview = string(runes[:60]) + "…"
				}
				log.Printf("   ↳ streamed chunk (%d chars): %q", len(c), preview)
			}
		}
	}
}

// -----------------------------------------------------------------------------
//  GROK-3 ENDPOINT
// -----------------------------------------------------------------------------

func runGrokPromptsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Prompts []string `json:"prompts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/plain")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	for _, prompt := range req.Prompts {
		fmt.Fprintf(w, "%s\n", mustJSON(map[string]string{"type": "prompt", "content": prompt}))
		flusher.Flush()

		if err := streamGrokAPI(w, flusher, prompt); err != nil {
			fmt.Fprintf(w, "%s\n", mustJSON(map[string]string{"type": "error", "content": err.Error()}))
			flusher.Flush()
		}

		fmt.Fprintf(w, "%s\n", mustJSON(map[string]string{"type": "end"}))
		flusher.Flush()
	}
}

// -----------------------------------------------------------------------------
//  STREAMING HELPER – Grok
// -----------------------------------------------------------------------------

func streamGrokAPI(w io.Writer, flusher http.Flusher, message string) error {
	apiKey := os.Getenv("GROK_API_KEY")
	if apiKey == "" {
		return fmt.Errorf("GROK_API_KEY not set")
	}

	payload := map[string]any{
		"model": "grok-3-latest",
		"messages": []map[string]string{
			{"role": "user", "content": message},
		},
		"search_parameters": map[string]any{
			"mode":               "auto",
			"max_search_results": 30,
			"return_citations":   true,
		},
		"stream": true,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest(
		http.MethodPost,
		"https://api.x.ai/v1/chat/completions",
		bytes.NewBuffer(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		e, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Grok API error %d: %s", resp.StatusCode, string(e))
	}

	reader := bufio.NewReader(resp.Body)
	for {
		line, err := reader.ReadString('\n')
		switch {
		case err == io.EOF:
			return nil
		case err != nil:
			return err
		case !strings.HasPrefix(line, "data: "):
			continue
		}

		data := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
		if data == "[DONE]" {
			return nil
		}

		var evt map[string]any
		if err := json.Unmarshal([]byte(data), &evt); err != nil {
			log.Println("⚠️ Grok parse error:", err)
			continue
		}

		if choices, ok := evt["choices"].([]any); ok && len(choices) > 0 {
			if choice, ok := choices[0].(map[string]any); ok {
				if delta, ok := choice["delta"].(map[string]any); ok {
					if content, ok := delta["content"].(string); ok && content != "" {
						out, _ := json.Marshal(
							map[string]string{"type": "chunk", "content": content},
						)
						fmt.Fprintf(w, "%s\n", out)
						flusher.Flush()

						preview := content
						if len([]rune(preview)) > 60 {
							preview = string([]rune(preview)[:60]) + "…"
						}
						log.Printf("   ↳ streamed chunk (%d chars): %q", len(content), preview)
					}
				}
			}
		}
	}
}

// -----------------------------------------------------------------------------
//  PPLX ENDPOINT
// -----------------------------------------------------------------------------

func runPPLXQueriesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct{ Queries []string `json:"queries"` }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	for _, q := range req.Queries {
		fmt.Fprintln(w, mustJSON(map[string]string{"type": "query", "content": q}))
		flusher.Flush()

		if err := streamPPLXAPI(w, flusher, q); err != nil {
			fmt.Fprintln(w, mustJSON(map[string]string{"type": "error", "content": err.Error()}))
			flusher.Flush()
		}

		fmt.Fprintln(w, mustJSON(map[string]string{"type": "end"}))
		flusher.Flush()
	}
}

// helper to marshal to JSON string
func mustJSON(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// streamPPLXAPI calls the Perplexity API and streams its response as one chunk
func streamPPLXAPI(w io.Writer, flusher http.Flusher, query string) error {
	apiKey := os.Getenv("PPLX_API_KEY")
	if apiKey == "" {
		return fmt.Errorf("PPLX_API_KEY not set")
	}

	payload := map[string]interface{}{
		"model":       "sonar-pro",
		"messages":    []map[string]string{{"role": "user", "content": query}},
		"search_mode": "sec",
	}
	bodyBytes, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, "https://api.perplexity.ai/chat/completions", bytes.NewBuffer(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Perplexity API error %d: %s", resp.StatusCode, string(b))
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	content := string(data)
	if err := json.Unmarshal(data, &out); err == nil && len(out.Choices) > 0 {
		content = out.Choices[0].Message.Content
	}

	fmt.Fprintln(w, mustJSON(map[string]string{"type": "chunk", "content": content}))
	flusher.Flush()
	return nil
}
