# Duplicate // Checker

A browser-based duplicate file checker. Choose a folder, scan files locally with SHA-256 hashes, review exact matches, and delete selected duplicates when the browser grants folder write permission.

## Run locally

Serve the `dist` directory over HTTP (folder access APIs require a secure context or localhost):

```sh
python3 -m http.server 4173 --directory dist
```

Then open http://localhost:4173.

## Run everything

Set up the local app once:

```sh
make setup
```

This verifies Python and Go, creates the repo-local cache/build directory, runs the native scanner tests, and builds the native helper.

Start both the frontend and native scanner with one command:

```sh
make run
```

Open http://localhost:4173. Press Ctrl-C once to stop both services.

## Fast USB mode

For very large USB drives, use the native Go scanner. In a second terminal:

```sh
go run ./native-scanner
```

Then enter the local folder path in the **Fast USB Mode** section, for example `/Volumes/My USB` on macOS. The helper listens only on `127.0.0.1:4317`, uses up to four parallel workers, streams duplicate candidates to the page, and stores its long-term hash history in this repo at `.duplicate-check-cache/hash-cache.jsonl`. The cache folder is Git-ignored. The browser-only folder picker remains available as a fallback.

Files are read and hashed in the browser. The app does not upload file contents. Chrome and Edge support the full choose-and-delete flow; the directory input fallback can scan but is read-only.

The scanner is designed for large removable drives: it first compares file sizes, reads a small first/last-chunk fingerprint for same-size candidates, performs full SHA-256 hashing only for candidates that survive that filter, uses Web Crypto for files up to 64 MB, reads larger candidates in 8 MB chunks, yields to the browser between chunks, and skips unreadable files or folder branches instead of aborting the entire scan.

Every scan ends with a persistent report showing the outcome, files found, candidates hashed, skipped items, skipped folder branches, and representative read errors. Partial duplicate results remain visible when possible.

The app also keeps a local IndexedDB hash index keyed by the selected root, relative file path, file size, and last-modified timestamp. On later scans, unchanged files reuse their stored hash and are marked `cached` in the results; changed or new files are checked again. Duplicate groups appear while the scan is still running, then switch to final results when complete.
