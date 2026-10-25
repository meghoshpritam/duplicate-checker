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

## Native scanner for large drives

For very large USB drives, the native Go scanner is started automatically by:

```sh
make run
```

Click **Choose folder / drive** and select the directory or mounted USB drive in the operating-system picker. The helper listens only on `127.0.0.1:4317`, uses up to four parallel workers, streams duplicate candidates to the page, and stores its long-term hash history in this repo at `.duplicate-check-cache/hash-cache.jsonl`. The cache folder is Git-ignored. `go run ./native-scanner` remains available when you want to start the helper separately.

When the native helper is connected, the main **Choose folder / drive** button opens the operating system's folder/drive picker and the main scan button uses the Go backend automatically. There is no separate USB scan flow to configure.

Files are read and hashed locally: the Go helper handles native scans when connected, while the browser provides a fallback. The app does not upload file contents. Chrome and Edge support the full choose-and-delete flow; the directory input fallback can scan but is read-only.

The scanner is designed for large removable drives: it first compares file sizes, reads a small first/last-chunk fingerprint for same-size candidates, performs full SHA-256 hashing only for candidates that survive that filter, uses Web Crypto for files up to 64 MB, reads larger candidates in 8 MB chunks, yields to the browser between chunks, and skips unreadable files or folder branches instead of aborting the entire scan.

Every scan ends with a persistent report showing the outcome, files found, candidates hashed, skipped items, skipped folder branches, and representative read errors. Partial duplicate results remain visible when possible.

The scan summary updates live as files are discovered: the readable folder size and file count grow during browser and native scans, while native mode also refreshes the selected drive's free space periodically. Browser-only mode cannot expose the selected drive's free-space information, so that value is shown as unavailable there.

Every scan enumerates the current directory tree and reads current file metadata; the cache never skips files. The app keeps a local IndexedDB hash index keyed by the selected root, relative file path, file size, and last-modified timestamp. On later scans, only a previously verified full SHA-256 hash may be reused when the file size and modification time still match; quick fingerprints are recomputed from the current file and are not persisted. New files that share a size with cached files are full-hashed even if their quick sample differs, so the sample cannot hide a duplicate. Reused hashes are marked `cached` in the results, while changed or new files are checked again. Use **Clear hash cache** in the scan panel to remove the browser IndexedDB history and, when the native helper is connected, the repo-backed `.duplicate-check-cache/hash-cache.jsonl` history too. This does not delete files; it only makes the next scan hash them afresh. Duplicate groups appear while the scan is still running, then switch to final results when complete.

During large scans, the live results area intentionally shows a bounded preview and updates in batches so the browser stays responsive. The complete duplicate list is rendered when the scan finishes.

Results can be shown as a **List** or **Tree**. Tree view groups files by their folders while keeping the same open, select, delete, filtering, and sorting actions. Duplicate copies are preselected, but the selection bar lets you select all visible copies, deselect everything, see the selected paths and reclaimable size, or delete the selection immediately. Each List group also has a **Select copies / Deselect copies** control for one-click section selection. Choose **Set original** on any file in a duplicate group to change which copy is kept; the other copies become selected for deletion. Filters include file type, location/name, and whether a hash was reused from cache. Sort groups by name/location, reclaimable space, duplicate copies, largest file, last modified, or hash, in ascending or descending order. **Open tab** opens the file in a new browser tab, while native scans also provide **Open app** to launch the operating system's default application.

The default original is selected with a conservative heuristic: an explicit user choice always wins; otherwise a clean filename is preferred over common copy suffixes such as `(1)`, `copy`, `- Copy`, `copy 2`, and a trailing space-number like `photo 1`; if every name is a variant, the lowest copy number wins, followed by the earliest modified file and then the shallowest path. A content hash proves that files are identical, but no cross-platform filesystem flag reliably proves which copy was created first, so the chosen original is always visible and can be changed before deletion.

Known OS metadata such as macOS `._*` AppleDouble files, `.DS_Store`, `Thumbs.db`, and `desktop.ini` is ignored and reported separately instead of being treated as scan errors.

If a short quick-fingerprint read fails because a USB file changes or does not support a partial read, the scanner falls back to a full hash for that file's size group. Only files that fail both reads remain in the real skipped-items count, with the underlying OS error shown in the report.
