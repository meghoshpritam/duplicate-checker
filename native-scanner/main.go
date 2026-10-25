package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"time"
)

const (
	port          = "127.0.0.1:4317"
	quickSample   = 64 * 1024
	workerLimit   = 4
	cacheFileName = "hash-cache.jsonl"
)

type fileRecord struct {
	AbsPath  string
	RelPath  string
	Size     int64
	Modified int64
	Hash     string
	Quick    string
	Cached   bool
}

type cacheEntry struct {
	Root     string `json:"root"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	Hash     string `json:"hash"`
	Quick    string `json:"quick"`
	SavedAt  int64  `json:"savedAt"`
}

type scanRequest struct {
	Path string `json:"path"`
}

type event struct {
	Type            string `json:"type"`
	Root            string `json:"root,omitempty"`
	Path            string `json:"path,omitempty"`
	AbsolutePath    string `json:"absolutePath,omitempty"`
	Size            int64  `json:"size,omitempty"`
	Modified        int64  `json:"modified,omitempty"`
	Hash            string `json:"hash,omitempty"`
	Cached          bool   `json:"cached,omitempty"`
	Message         string `json:"message,omitempty"`
	FilesFound      int    `json:"filesFound,omitempty"`
	ReusedHashes    int    `json:"reusedHashes,omitempty"`
	QuickCandidates int    `json:"quickCandidates,omitempty"`
	FullCandidates  int    `json:"fullCandidates,omitempty"`
	FullHashes      int    `json:"fullHashes,omitempty"`
	Skipped         int    `json:"skipped,omitempty"`
	DurationMs      int64  `json:"durationMs,omitempty"`
	Phase           string `json:"phase,omitempty"`
	Current         int    `json:"current,omitempty"`
	Total           int    `json:"total,omitempty"`
}

type workerResult struct {
	Index int
	Value string
	Err   error
}

type scanner struct {
	Root    string
	Cache   map[string]cacheEntry
	Changed map[string]cacheEntry
}

var allowedDeletes = struct {
	sync.RWMutex
	paths map[string]bool
}{paths: make(map[string]bool)}

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/scan", scanHandler)
	http.HandleFunc("/delete", deleteHandler)

	fmt.Printf("Duplicate Checker native scanner listening on http://%s\n", port)
	fmt.Println("Use the browser UI's Native scanner section for large USB drives.")
	if err := http.ListenAndServe(port, withCORS(http.DefaultServeMux)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workers": workerCount()})
}

func scanHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var request scanRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON request"})
		return
	}
	root, err := filepath.Abs(filepath.Clean(request.Path))
	if err != nil || root == "." {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid folder path"})
		return
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is not a readable folder"})
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, canFlush := w.(http.Flusher)
	send := func(e event) error {
		data, marshalErr := json.Marshal(e)
		if marshalErr != nil {
			return marshalErr
		}
		if _, writeErr := fmt.Fprintf(w, "%s\n", data); writeErr != nil {
			return writeErr
		}
		if canFlush {
			flusher.Flush()
		}
		return nil
	}

	started := time.Now()
	cache, cachePath := loadCache(root)
	s := &scanner{Root: root, Cache: cache, Changed: make(map[string]cacheEntry)}
	if err := send(event{Type: "start", Root: root}); err != nil {
		return
	}

	records, warnings := collectFiles(root)
	initialWarningCount := len(warnings)
	for _, warning := range warnings {
		_ = send(event{Type: "warning", Path: warning.path, Message: warning.message})
	}

	sameSize := make(map[int64][]int)
	reused := 0
	for index := range records {
		record := &records[index]
		key := record.RelPath
		if cached, ok := cache[key]; ok && cached.Size == record.Size && cached.Modified == record.Modified && cached.Hash != "" {
			record.Hash = cached.Hash
			record.Quick = cached.Quick
			record.Cached = true
			reused++
		} else {
			sameSize[record.Size] = append(sameSize[record.Size], index)
		}
	}

	// Include cached records when building candidate buckets so a changed/new
	// file can match a cached file without re-hashing the cached copy.
	for size, indices := range sameSize {
		if len(indices) < 2 {
			delete(sameSize, size)
		}
	}
	for size, all := range sizeBuckets(records) {
		if len(all) > 1 {
			sameSize[size] = all
		}
	}

	quickIndices := make([]int, 0)
	for _, indices := range sameSize {
		for _, index := range indices {
			if records[index].Quick == "" {
				quickIndices = append(quickIndices, index)
			}
		}
	}
	quickResults := parallelHash(quickIndices, workerCount(), func(index int) (string, error) {
		return quickFingerprint(records[index].AbsPath, records[index].Size)
	})
	quickDone := 0
	for result := range quickResults {
		if result.Err != nil {
			warnings = append(warnings, warning{records[result.Index].RelPath, result.Err.Error()})
			continue
		}
		records[result.Index].Quick = result.Value
		quickDone++
		_ = send(event{Type: "progress", Phase: "quick", Current: quickDone, Total: len(quickIndices)})
	}

	quickGroups := make(map[string][]int)
	for _, indices := range sameSize {
		for _, index := range indices {
			if records[index].Quick != "" {
				key := fmt.Sprintf("%d:%s", records[index].Size, records[index].Quick)
				quickGroups[key] = append(quickGroups[key], index)
			}
		}
	}
	fullIndices := make([]int, 0)
	for _, indices := range quickGroups {
		if len(indices) > 1 {
			for _, index := range indices {
				if records[index].Hash == "" {
					fullIndices = append(fullIndices, index)
				}
			}
		}
	}
	fullResults := parallelHash(fullIndices, workerCount(), func(index int) (string, error) {
		return fullHash(records[index].AbsPath)
	})
	for _, indices := range quickGroups {
		if len(indices) <= 1 {
			continue
		}
		for _, index := range indices {
			record := records[index]
			if record.Hash != "" {
				_ = send(event{Type: "file", Path: record.RelPath, AbsolutePath: record.AbsPath, Size: record.Size, Modified: record.Modified, Hash: record.Hash, Cached: record.Cached})
			}
		}
	}
	fullDone := 0
	for result := range fullResults {
		if result.Err != nil {
			warnings = append(warnings, warning{records[result.Index].RelPath, result.Err.Error()})
			continue
		}
		record := &records[result.Index]
		record.Hash = result.Value
		s.Changed[record.RelPath] = cacheEntry{Root: root, Path: record.RelPath, Size: record.Size, Modified: record.Modified, Hash: record.Hash, Quick: record.Quick, SavedAt: time.Now().UnixMilli()}
		fullDone++
		_ = send(event{Type: "file", Path: record.RelPath, AbsolutePath: record.AbsPath, Size: record.Size, Modified: record.Modified, Hash: record.Hash})
		_ = send(event{Type: "progress", Phase: "full", Current: fullDone, Total: len(fullIndices)})
	}

	for _, warning := range warnings[initialWarningCount:] {
		_ = send(event{Type: "warning", Path: warning.path, Message: warning.message})
	}
	if err := appendCache(cachePath, s.Changed); err != nil {
		_ = send(event{Type: "warning", Message: "Could not save native hash history: " + err.Error()})
	}
	finalDuplicates := duplicateRecords(records)
	allowedDeletes.Lock()
	allowedDeletes.paths = make(map[string]bool, len(finalDuplicates))
	for _, index := range finalDuplicates {
		allowedDeletes.paths[records[index].AbsPath] = true
	}
	allowedDeletes.Unlock()
	_ = send(event{Type: "done", Root: root, FilesFound: len(records), ReusedHashes: reused, QuickCandidates: len(quickIndices), FullCandidates: len(fullIndices), FullHashes: len(s.Changed), Skipped: len(warnings), DurationMs: time.Since(started).Milliseconds()})
}

func deleteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	// Deletion is intentionally kept out of the scanner service's global state.
	// The browser still confirms each delete, then sends one exact file path.
	var request struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid file path"})
		return
	}
	allowedDeletes.RLock()
	isAllowed := allowedDeletes.paths[request.Path]
	allowedDeletes.RUnlock()
	if !isAllowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "file was not returned as a duplicate by the latest scan"})
		return
	}
	info, err := os.Stat(request.Path)
	if err != nil || info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file does not exist or is a folder"})
		return
	}
	if err := os.Remove(request.Path); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type warning struct{ path, message string }

func collectFiles(root string) ([]fileRecord, []warning) {
	records := make([]fileRecord, 0)
	warnings := make([]warning, 0)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			warnings = append(warnings, warning{path, walkErr.Error()})
			return nil
		}
		if entry.IsDir() || !entry.Type().IsRegular() {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			warnings = append(warnings, warning{path, infoErr.Error()})
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			warnings = append(warnings, warning{path, relErr.Error()})
			return nil
		}
		records = append(records, fileRecord{AbsPath: path, RelPath: filepath.ToSlash(rel), Size: info.Size(), Modified: info.ModTime().UnixMilli()})
		return nil
	})
	if err != nil {
		warnings = append(warnings, warning{root, err.Error()})
	}
	return records, warnings
}

func sizeBuckets(records []fileRecord) map[int64][]int {
	buckets := make(map[int64][]int)
	for index, record := range records {
		buckets[record.Size] = append(buckets[record.Size], index)
	}
	return buckets
}

func duplicateRecords(records []fileRecord) []int {
	byHash := make(map[string][]int)
	for index, record := range records {
		if record.Hash != "" {
			byHash[record.Hash] = append(byHash[record.Hash], index)
		}
	}
	indices := make([]int, 0)
	for _, group := range byHash {
		if len(group) > 1 {
			indices = append(indices, group...)
		}
	}
	sort.Ints(indices)
	return indices
}

func quickFingerprint(path string, size int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if size <= quickSample*2 {
		if _, err := io.CopyN(hasher, file, size); err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
	} else {
		first := make([]byte, quickSample)
		last := make([]byte, quickSample)
		if _, err := io.ReadFull(file, first); err != nil {
			return "", err
		}
		if _, err := file.ReadAt(last, size-quickSample); err != nil {
			return "", err
		}
		_, _ = hasher.Write(first)
		_, _ = hasher.Write(last)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func fullHash(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	buffer := make([]byte, 1024*1024)
	if _, err := io.CopyBuffer(hasher, file, buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func parallelHash(indices []int, workers int, fn func(int) (string, error)) <-chan workerResult {
	results := make(chan workerResult, len(indices))
	if len(indices) == 0 {
		close(results)
		return results
	}
	jobs := make(chan int)
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for index := range jobs {
				value, err := fn(index)
				results <- workerResult{Index: index, Value: value, Err: err}
			}
		}()
	}
	go func() {
		for _, index := range indices {
			jobs <- index
		}
		close(jobs)
		wait.Wait()
		close(results)
	}()
	return results
}

func workerCount() int {
	count := runtime.NumCPU()
	if count < 1 {
		count = 1
	}
	if count > workerLimit {
		count = workerLimit
	}
	return count
}

func cacheLocation() string {
	directory := filepath.Join(repoRoot(), ".duplicate-check-cache")
	_ = os.MkdirAll(directory, 0o755)
	return filepath.Join(directory, cacheFileName)
}

func repoRoot() string {
	if override := os.Getenv("DUPLICATE_CHECK_CACHE_DIR"); override != "" {
		return override
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		return "."
	}
	for directory := workingDirectory; ; directory = filepath.Dir(directory) {
		if _, err := os.Stat(filepath.Join(directory, "native-scanner", "go.mod")); err == nil {
			return directory
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return workingDirectory
		}
	}
}

func loadCache(root string) (map[string]cacheEntry, string) {
	cache := make(map[string]cacheEntry)
	path := cacheLocation()
	file, err := os.Open(path)
	if err != nil {
		return cache, path
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var entry cacheEntry
		if json.Unmarshal(scanner.Bytes(), &entry) == nil && entry.Root == root && entry.Path != "" {
			cache[entry.Path] = entry
		}
	}
	return cache, path
}

func appendCache(path string, entries map[string]cacheEntry) error {
	if len(entries) == 0 {
		return nil
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	for _, entry := range entries {
		data, marshalErr := json.Marshal(entry)
		if marshalErr != nil {
			return marshalErr
		}
		if _, writeErr := file.Write(append(data, '\n')); writeErr != nil {
			return writeErr
		}
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
