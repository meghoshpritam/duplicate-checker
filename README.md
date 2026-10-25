# Duplicate // Checker

A browser-based duplicate file checker. Choose a folder, scan files locally with SHA-256 hashes, review exact matches, and delete selected duplicates when the browser grants folder write permission.

## Run locally

Serve the `dist` directory over HTTP (folder access APIs require a secure context or localhost):

```sh
python3 -m http.server 4173 --directory dist
```

Then open http://localhost:4173.

Files are read and hashed in the browser. The app does not upload file contents. Chrome and Edge support the full choose-and-delete flow; the directory input fallback can scan but is read-only.

The scanner is designed for large removable drives: it first compares file sizes, hashes only same-size candidates, reads candidate files in 8 MB chunks, yields to the browser between chunks, and skips unreadable files or folder branches instead of aborting the entire scan.

Every scan ends with a persistent report showing the outcome, files found, candidates hashed, skipped items, skipped folder branches, and representative read errors. Partial duplicate results remain visible when possible.
