package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type testScanEvent struct {
	Type         string `json:"type"`
	Path         string `json:"path"`
	Hash         string `json:"hash"`
	FilesFound   int    `json:"filesFound"`
	ReusedHashes int    `json:"reusedHashes"`
	FullHashes   int    `json:"fullHashes"`
}

func runTestScan(t *testing.T, root, cacheDir string) []testScanEvent {
	t.Helper()
	t.Setenv("DUPLICATE_CHECK_CACHE_DIR", cacheDir)
	body, err := json.Marshal(scanRequest{Path: root})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/scan", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	scanHandler(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("scan status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	events := make([]testScanEvent, 0)
	scanner := bufio.NewScanner(strings.NewReader(recorder.Body.String()))
	for scanner.Scan() {
		var event testScanEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

func findTestDone(events []testScanEvent) testScanEvent {
	for _, event := range events {
		if event.Type == "done" {
			return event
		}
	}
	return testScanEvent{}
}

func countTestFiles(events []testScanEvent) int {
	count := 0
	for _, event := range events {
		if event.Type == "file" {
			count++
		}
	}
	return count
}

func TestNewDuplicateIsCheckedAgainstCachedFile(t *testing.T) {
	root := t.TempDir()
	cacheDir := t.TempDir()
	content := []byte("the same content")
	if err := os.WriteFile(filepath.Join(root, "original.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	first := runTestScan(t, root, cacheDir)
	if done := findTestDone(first); done.FilesFound != 1 || done.FullHashes != 0 {
		t.Fatalf("first scan = %+v, want one discovered file and no duplicate hash work", done)
	}
	if err := os.WriteFile(filepath.Join(root, "original (1).txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	second := runTestScan(t, root, cacheDir)
	done := findTestDone(second)
	if done.FilesFound != 2 || done.FullHashes != 2 || countTestFiles(second) != 2 {
		t.Fatalf("second scan = %+v with %d file events, want both files checked", done, countTestFiles(second))
	}
}

func TestNewDuplicateUsesCachedHashWhenGroupAlreadyExists(t *testing.T) {
	root := t.TempDir()
	cacheDir := t.TempDir()
	content := []byte("the same content")
	for _, name := range []string{"original.txt", "copy.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), content, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	runTestScan(t, root, cacheDir)
	if err := os.WriteFile(filepath.Join(root, "copy 2.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	second := runTestScan(t, root, cacheDir)
	done := findTestDone(second)
	if done.FilesFound != 3 || done.ReusedHashes != 2 || done.FullHashes != 1 || countTestFiles(second) != 3 {
		t.Fatalf("second scan = %+v with %d file events, want two reused hashes and one new hash", done, countTestFiles(second))
	}
}
