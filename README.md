# Duplicate // Checker

A browser-based duplicate file checker. Choose a folder, scan files locally with SHA-256 hashes, review exact matches, and delete selected duplicates when the browser grants folder write permission.

## Run locally

Serve the `dist` directory over HTTP (folder access APIs require a secure context or localhost):

```sh
python3 -m http.server 4173 --directory dist
```

Then open http://localhost:4173.

Files are read and hashed in the browser. The app does not upload file contents. Chrome and Edge support the full choose-and-delete flow; the directory input fallback can scan but is read-only.
