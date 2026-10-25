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
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
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
	Ignored         int    `json:"ignored,omitempty"`
	DurationMs      int64  `json:"durationMs,omitempty"`
	FolderBytes     int64  `json:"folderBytes,omitempty"`
	DiskTotalBytes  int64  `json:"diskTotalBytes,omitempty"`
	DiskFreeBytes   int64  `json:"diskFreeBytes,omitempty"`
	StorageError    string `json:"storageError,omitempty"`
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
	http.HandleFunc("/cache", cacheHandler)
	http.HandleFunc("/storage", storageHandler)
	http.HandleFunc("/pick", pickHandler)
	http.HandleFunc("/scan", scanHandler)
	http.HandleFunc("/delete", deleteHandler)
	http.HandleFunc("/file", fileHandler)
	http.HandleFunc("/open", openHandler)

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

func cacheHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	path := cacheLocation()
	err := os.Remove(path)
	removed := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not clear native hash cache: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": removed})
}

func storageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET required"})
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	totalBytes, freeBytes, err := diskSpace(path)
	payload := map[string]any{"diskTotalBytes": totalBytes, "diskFreeBytes": freeBytes}
	if err != nil {
		payload["storageError"] = err.Error()
	}
	writeJSON(w, http.StatusOK, payload)
}

func pickHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET required"})
		return
	}
	path, err := chooseDirectory()
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

func chooseDirectory() (string, error) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("osascript", "-e", `POSIX path of (choose folder with prompt "Choose a folder or USB drive")`)
	case "windows":
		command = exec.Command("powershell", "-NoProfile", "-Command", `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose a folder or USB drive'; if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath } else { exit 1 }`)
	case "linux":
		if zenity, err := exec.LookPath("zenity"); err == nil {
			command = exec.Command(zenity, "--file-selection", "--directory", "--title=Choose a folder or USB drive")
		} else if kdialog, err := exec.LookPath("kdialog"); err == nil {
			command = exec.Command(kdialog, "--getexistingdirectory", ".", "Choose a folder or USB drive")
		} else {
			return "", fmt.Errorf("no native folder picker found; install zenity or kdialog")
		}
	default:
		return "", fmt.Errorf("native folder picker is not supported on %s", runtime.GOOS)
	}
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("folder selection cancelled or failed")
	}
	path := strings.TrimSpace(string(output))
	if path == "" {
		return "", fmt.Errorf("folder selection cancelled")
	}
	return filepath.Clean(path), nil
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

	lastStorageUpdate := time.Time{}
	sendStorage := func(folderBytes int64, filesFound, ignored int) {
		if !lastStorageUpdate.IsZero() && time.Since(lastStorageUpdate) < 350*time.Millisecond && filesFound > 0 {
			return
		}
		lastStorageUpdate = time.Now()
		diskTotalBytes, diskFreeBytes, storageErr := diskSpace(root)
		storageEvent := event{Type: "storage", FilesFound: filesFound, Ignored: ignored, FolderBytes: folderBytes, DiskTotalBytes: diskTotalBytes, DiskFreeBytes: diskFreeBytes}
		if storageErr != nil {
			storageEvent.StorageError = storageErr.Error()
		}
		_ = send(storageEvent)
	}
	sendStorage(0, 0, 0)
	records, warnings, ignored := collectFiles(root, func(folderBytes int64, filesFound, ignored int) {
		sendStorage(folderBytes, filesFound, ignored)
	})
	initialWarningCount := len(warnings)
	folderBytes := int64(0)
	for _, record := range records {
		folderBytes += record.Size
	}
	diskTotalBytes, diskFreeBytes, storageErr := diskSpace(root)
	sendStorage(folderBytes, len(records), ignored)
	for _, warning := range warnings {
		_ = send(event{Type: "warning", Path: warning.path, Message: warning.message})
	}

	sameSize := make(map[int64][]int)
	cachedSizes := make(map[int64]bool)
	reused := 0
	for index := range records {
		record := &records[index]
		key := record.RelPath
		if cached, ok := cache[key]; ok && cached.Size == record.Size && cached.Modified == record.Modified && cached.Hash != "" {
			record.Hash = cached.Hash
			record.Cached = true
			cachedSizes[record.Size] = true
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
	allSizeBuckets := sizeBuckets(records)
	for size, all := range allSizeBuckets {
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
	quickFailedSizes := make(map[int64]bool)
	quickErrors := make(map[int]error)
	quickDone := 0
	for result := range quickResults {
		if result.Err != nil {
			quickFailedSizes[records[result.Index].Size] = true
			quickErrors[result.Index] = result.Err
			continue
		}
		records[result.Index].Quick = result.Value
		quickDone++
		if quickDone%50 == 0 || quickDone == len(quickIndices) {
			_ = send(event{Type: "progress", Phase: "quick", Current: quickDone, Total: len(quickIndices)})
		}
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
	fullIndexSet := make(map[int]bool)
	for _, indices := range quickGroups {
		if len(indices) > 1 {
			for _, index := range indices {
				if records[index].Hash == "" {
					fullIndexSet[index] = true
				}
			}
		}
	}
	// If a quick read fails for one file in a size group, full-hash the whole
	// group. This preserves exact duplicate detection instead of dropping that
	// group from the scan just because a short sample read was unavailable.
	for size := range quickFailedSizes {
		for _, indices := range sameSize {
			if len(indices) == 0 || records[indices[0]].Size != size {
				continue
			}
			for _, index := range indices {
				if records[index].Hash == "" {
					fullIndexSet[index] = true
				}
			}
		}
	}
	// A new file must still be checked against cached files of the same size
	// even when a short sample differs. The sample is an optimization, not a
	// correctness gate for files whose full hash has not been verified yet.
	for size := range cachedSizes {
		for _, index := range allSizeBuckets[size] {
			if records[index].Hash == "" {
				fullIndexSet[index] = true
			}
		}
	}
	fullIndices := make([]int, 0, len(fullIndexSet))
	for index := range fullIndexSet {
		fullIndices = append(fullIndices, index)
	}
	sort.Ints(fullIndices)
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
			message := "full hash failed: " + result.Err.Error()
			if quickErr, ok := quickErrors[result.Index]; ok {
				message = fmt.Sprintf("quick fingerprint failed: %v; full hash failed: %v", quickErr, result.Err)
			}
			warnings = append(warnings, warning{records[result.Index].RelPath, message})
			continue
		}
		record := &records[result.Index]
		record.Hash = result.Value
		s.Changed[record.RelPath] = cacheEntry{Root: root, Path: record.RelPath, Size: record.Size, Modified: record.Modified, Hash: record.Hash, SavedAt: time.Now().UnixMilli()}
		fullDone++
		_ = send(event{Type: "file", Path: record.RelPath, AbsolutePath: record.AbsPath, Size: record.Size, Modified: record.Modified, Hash: record.Hash})
		if fullDone%10 == 0 || fullDone == len(fullIndices) {
			_ = send(event{Type: "progress", Phase: "full", Current: fullDone, Total: len(fullIndices)})
		}
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
	_ = send(event{Type: "done", Root: root, FilesFound: len(records), ReusedHashes: reused, QuickCandidates: len(quickIndices), FullCandidates: len(fullIndices), FullHashes: len(s.Changed), Skipped: len(warnings), Ignored: ignored, DurationMs: time.Since(started).Milliseconds(), FolderBytes: folderBytes, DiskTotalBytes: diskTotalBytes, DiskFreeBytes: diskFreeBytes, StorageError: storageErrorText(storageErr)})
}

func storageErrorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
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

func fileHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET required"})
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid file path"})
		return
	}
	allowedDeletes.RLock()
	isAllowed := allowedDeletes.paths[path]
	allowedDeletes.RUnlock()
	if !isAllowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "file was not returned as a duplicate by the latest scan"})
		return
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "file does not exist or is a folder"})
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	defer file.Close()
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func openHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
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
	if info, err := os.Stat(request.Path); err != nil || info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file does not exist or is a folder"})
		return
	}

	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", request.Path)
	case "windows":
		command = exec.Command("cmd", "/c", "start", "", request.Path)
	case "linux":
		command = exec.Command("xdg-open", request.Path)
	default:
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "open is not supported on this operating system"})
		return
	}
	if err := command.Start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type warning struct{ path, message string }

func collectFiles(root string, onUpdate func(folderBytes int64, filesFound, ignored int)) ([]fileRecord, []warning, int) {
	records := make([]fileRecord, 0)
	warnings := make([]warning, 0)
	ignored := 0
	var folderBytes int64
	lastUpdate := time.Time{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			warnings = append(warnings, warning{path, walkErr.Error()})
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if isSystemMetadataFile(entry.Name()) {
			ignored++
			return nil
		}
		if !entry.Type().IsRegular() {
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
		folderBytes += info.Size()
		if onUpdate != nil && (len(records)%128 == 0 || time.Since(lastUpdate) >= 350*time.Millisecond) {
			lastUpdate = time.Now()
			onUpdate(folderBytes, len(records), ignored)
		}
		return nil
	})
	if err != nil {
		warnings = append(warnings, warning{root, err.Error()})
	}
	if onUpdate != nil {
		onUpdate(folderBytes, len(records), ignored)
	}
	return records, warnings, ignored
}

func isSystemMetadataFile(name string) bool {
	lowerName := strings.ToLower(name)
	return strings.HasPrefix(name, "._") || lowerName == ".ds_store" || lowerName == "thumbs.db" || lowerName == "desktop.ini"
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
	actualInfo, err := file.Stat()
	if err != nil {
		return "", err
	}
	actualSize := actualInfo.Size()
	if actualSize <= quickSample*2 {
		data := make([]byte, actualSize)
		read, readErr := file.ReadAt(data, 0)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return "", readErr
		}
		if read > 0 {
			_, _ = hasher.Write(data[:read])
		}
	} else {
		first := make([]byte, quickSample)
		last := make([]byte, quickSample)
		firstRead, firstErr := file.ReadAt(first, 0)
		lastRead, lastErr := file.ReadAt(last, actualSize-quickSample)
		if firstErr != nil && !errors.Is(firstErr, io.EOF) {
			return "", firstErr
		}
		if lastErr != nil && !errors.Is(lastErr, io.EOF) {
			return "", lastErr
		}
		if firstRead == 0 || lastRead == 0 {
			return "", io.ErrUnexpectedEOF
		}
		_, _ = hasher.Write(first[:firstRead])
		_, _ = hasher.Write(last[:lastRead])
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
