# Audio Pipeline - Project Specification

## Project Overview

An automated audio file organization and metadata correction pipeline that identifies songs via audio fingerprinting, searches the web for accurate metadata, fixes ID3 tags, adds synchronized lyrics, and renames files according to a consistent convention. Built with Node.js/TypeScript + Electron for a cross-platform GUI with bulk processing capabilities.

**Primary Requirements:** Speed and Accuracy  
**Target Platform:** Windows  
**Supported Formats:** MP3, FLAC, M4A, WAV, OGG, WMA

## Features to Implement

### Feature 1: Project Setup and Dependencies
**Priority:** Critical  
**Status:** Not Started

**Description:**
Initialize Node.js/TypeScript project with Electron, install core dependencies for audio processing (music-metadata, node-acoustid, musicbrainz-api), ID3 tag editing (node-id3), and testing framework (Jest/Vitest).

**Acceptance Criteria:**
- [ ] package.json created with all required dependencies
- [ ] TypeScript configuration (tsconfig.json) with strict mode enabled
- [ ] Electron main and renderer process boilerplate created
- [ ] Project builds successfully with `npm run build`
- [ ] Basic test suite runs with `npm test`
- [ ] ESLint and Prettier configured for code quality

**Technical Notes:**
- Use `music-metadata` for reading audio file metadata
- Use `node-acoustid` for AcoustID fingerprinting (free service)
- Use `musicbrainz-api` for metadata retrieval
- Use `node-id3` or `music-metadata` for writing ID3 tags
- Consider `axios` or `node-fetch` for web requests (lyrics APIs)

---

### Feature 2: Audio File Reading and Metadata Extraction
**Priority:** Critical  
**Status:** Not Started

**Description:**
Read audio files (MP3, FLAC, M4A, WAV, OGG, WMA), extract existing metadata (ID3 tags), and prepare file information for processing. Core data layer that other features depend on.

**Acceptance Criteria:**
- [ ] Function reads audio file and extracts existing metadata (title, artist, album, year, etc.)
- [ ] Supports all target formats: MP3, FLAC, M4A, WAV, OGG, WMA
- [ ] Returns structured metadata object with parsed fields
- [ ] Handles corrupted or missing metadata gracefully (returns partial data)
- [ ] Unit tests cover all supported formats
- [ ] Performance: processes file metadata in <100ms per file

**Technical Notes:**
- Use `music-metadata` library's parseFile() function
- Create TypeScript interface for AudioFileMetadata
- Handle encoding issues (UTF-8, Latin-1, etc.)
- Store original file path and format for later operations

---

### Feature 3: Audio Fingerprinting with AcoustID
**Priority:** Critical  
**Status:** Not Started

**Description:**
Generate audio fingerprint using Chromaprint and query AcoustID (free service) to identify songs with high accuracy. This is the core identification mechanism.

**Acceptance Criteria:**
- [ ] Generates audio fingerprint using fpcalc/Chromaprint
- [ ] Queries AcoustID API with fingerprint and duration
- [ ] Returns matched recordings with confidence scores (>0.9 = high confidence)
- [ ] Handles API rate limits gracefully (retry with exponential backoff)
- [ ] Caches results to avoid duplicate API calls for same file
- [ ] Unit tests with sample audio files verify identification accuracy
- [ ] Performance: fingerprinting + API call completes in <5 seconds per file

**Technical Notes:**
- AcoustID requires fpcalc binary (bundle with app or require installation)
- Free tier: 3 requests/second, register for API key at acoustid.org
- Use MusicBrainz RecordingID from AcoustID response to fetch metadata
- Implement caching layer (in-memory Map or SQLite) to avoid redundant API calls

---

### Feature 4: Metadata Fetching from MusicBrainz
**Priority:** High  
**Status:** Not Started

**Description:**
Fetch comprehensive song metadata (artist, song name, album, year, genre) from MusicBrainz using the RecordingID obtained from AcoustID. Ensures accurate, canonical naming.

**Acceptance Criteria:**
- [ ] Queries MusicBrainz API with RecordingID from AcoustID
- [ ] Extracts artist name(s), recording title, release (album) name, year, genre
- [ ] Handles multiple artists (featured artists, collaborations) correctly
- [ ] Respects MusicBrainz rate limit (1 request/second for unauthenticated)
- [ ] Returns structured metadata object matching AudioFileMetadata interface
- [ ] Unit tests verify metadata extraction for various music genres
- [ ] Falls back gracefully if MusicBrainz has incomplete data

**Technical Notes:**
- MusicBrainz API: https://musicbrainz.org/ws/2/
- Use `musicbrainz-api` npm package or direct REST calls
- Implement request throttling (queue pattern) to respect rate limits
- Handle disambiguation (multiple releases of same recording)

---

### Feature 5: Lyrics Fetching from Free Sources
**Priority:** High  
**Status:** Not Started

**Description:**
Search for and retrieve unsynchronized lyrics (USLT) from free sources (LRCLIB, ChartLyrics, or web scraping as fallback). Match lyrics to the identified song using artist + title.

**Acceptance Criteria:**
- [ ] Queries LRCLIB API (no key required) with artist + song title
- [ ] Falls back to ChartLyrics API if LRCLIB returns no results
- [ ] Validates lyrics match (checks for artist/title in lyrics metadata)
- [ ] Cleans up lyrics formatting (removes extra whitespace, ads, copyright notices)
- [ ] Returns plain text USLT lyrics (not synced LRC format for this feature)
- [ ] Handles API failures gracefully (returns null if no lyrics found)
- [ ] Unit tests verify lyrics retrieval for popular songs

**Technical Notes:**
- LRCLIB API: https://lrclib.net/api (free, no auth)
- ChartLyrics API: http://api.chartlyrics.com/ (free, SOAP/REST)
- Store lyrics as UTF-8 plain text for USLT ID3 frame
- Consider caching lyrics to avoid redundant API calls

---

### Feature 6: ID3 Tag Writing and File Renaming
**Priority:** High  
**Status:** Not Started

**Description:**
Write corrected metadata to audio file ID3 tags (or equivalent for FLAC/M4A) and rename files to "Artist - Song Name.ext" format. Preserves audio quality (no re-encoding).

**Acceptance Criteria:**
- [ ] Writes ID3v2.4 tags for MP3 files (artist, title, album, year, genre, USLT)
- [ ] Writes equivalent tags for FLAC (Vorbis comments) and M4A (MP4 tags)
- [ ] Renames file to "Artist - Song Name.ext" format
- [ ] Sanitizes filenames (removes invalid characters: / \\ : * ? " < > |)
- [ ] Handles filename collisions (appends (1), (2), etc. if file exists)
- [ ] Does NOT re-encode audio (metadata-only modification)
- [ ] Unit tests verify tags are written correctly and readable
- [ ] Performance: writes tags in <200ms per file

**Technical Notes:**
- Use `node-id3` for MP3, `music-metadata` for FLAC/M4A
- ID3v2.4 USLT frame format: language code (eng), descriptor (empty), text
- Backup original file before writing (optional, for safety)
- Use atomic file operations (write to temp, then rename)

---

### Feature 7: Basic Electron GUI - File Selection
**Priority:** High  
**Status:** Not Started

**Description:**
Create Electron application with a simple GUI for selecting audio files or folders for processing. Displays selected files in a list view.

**Acceptance Criteria:**
- [ ] Electron app launches with a main window (800x600px)
- [ ] "Select Files" button opens native file picker (multi-select)
- [ ] "Select Folder" button opens folder picker, scans for audio files
- [ ] File list displays: filename, format, size, current metadata (if available)
- [ ] "Start Processing" button triggers batch processing (disabled if no files)
- [ ] App package builds for Windows with `npm run package`
- [ ] UI is responsive and doesn't freeze during file scanning

**Technical Notes:**
- Use Electron's IPC (inter-process communication) for main ↔ renderer
- Renderer: HTML + CSS (or React if preferred)
- File scanning: recursively find audio files in selected folder
- Filter files by extension: .mp3, .flac, .m4a, .wav, .ogg, .wma

---

### Feature 8: Progress Tracking and Status Display
**Priority:** Medium  
**Status:** Not Started

**Description:**
Real-time progress tracking during bulk processing. Displays current file being processed, success/error counts, and estimated time remaining.

**Acceptance Criteria:**
- [ ] Progress bar shows percentage completion (files processed / total)
- [ ] Status text displays: "Processing: Artist - Song Name.mp3 (42/1000)"
- [ ] Success/error counters update in real-time
- [ ] Estimated time remaining calculated based on average processing time
- [ ] "Cancel" button stops processing gracefully (finishes current file, then stops)
- [ ] Processed files marked with status icon (✓ success, ✗ error, ⚠ skipped)
- [ ] UI remains responsive during processing (uses background workers)

**Technical Notes:**
- Use Electron IPC to send progress updates from main to renderer
- Consider Web Workers or Node.js Worker Threads for parallel processing
- Calculate ETA: (total - processed) × average_time_per_file
- Update UI at most 10 times per second to avoid performance issues

---

### Feature 9: Error Handling and Logging
**Priority:** Medium  
**Status:** Not Started

**Description:**
Comprehensive error handling for all processing steps. Logs errors to file, displays user-friendly error messages, and allows users to review/export error log.

**Acceptance Criteria:**
- [ ] All errors caught and logged with context (filename, step, error message)
- [ ] Unidentifiable files auto-skipped and logged (doesn't halt processing)
- [ ] Log file created at: `%APPDATA%/audio-pipeline/logs/YYYY-MM-DD.log`
- [ ] "View Errors" button in GUI opens error log viewer
- [ ] "Export Error Log" button saves log to user-selected location
- [ ] Error categories: FileReadError, FingerprintError, APIError, WriteError
- [ ] Unit tests verify error handling for each step

**Technical Notes:**
- Use `winston` or `pino` for structured logging
- Log levels: ERROR (processing failures), WARN (skipped files), INFO (progress)
- Rotate log files daily or when size exceeds 10MB
- Include stack traces for debugging, but sanitize for user display

---

### Feature 10: Batch Processing with Concurrency Control
**Priority:** Medium  
**Status:** Not Started

**Description:**
Process large libraries efficiently with configurable concurrency (e.g., 5 files at once) to maximize throughput while respecting API rate limits.

**Acceptance Criteria:**
- [ ] Processes multiple files concurrently (configurable, default: 5)
- [ ] Respects API rate limits (AcoustID: 3/sec, MusicBrainz: 1/sec)
- [ ] Queue system ensures API limits never exceeded
- [ ] Settings panel allows user to adjust concurrency (1-10)
- [ ] Performance: processes at least 100 files in 10 minutes (with API calls)
- [ ] Memory usage stays below 500MB even with 10,000+ file queue
- [ ] Unit tests verify rate limiting is enforced

**Technical Notes:**
- Use `p-queue` or `async` library for concurrency control
- Implement token bucket algorithm for API rate limiting
- Process flow: fingerprint → API calls → metadata write (fingerprinting can be parallel)
- Cache fingerprints to avoid redundant fpcalc calls

---

### Feature 11: Settings and Configuration Panel
**Priority:** Low  
**Status:** Not Started

**Description:**
Settings panel for user preferences: output folder, naming convention, concurrency, API keys (future), and toggle features (lyrics, album art).

**Acceptance Criteria:**
- [ ] Settings panel accessible from menu bar (File → Settings)
- [ ] Output folder selection (default: same as input)
- [ ] Naming convention template (default: "Artist - Song Name")
- [ ] Concurrency slider (1-10, default: 5)
- [ ] Toggle: "Fetch Lyrics" (on/off)
- [ ] Toggle: "Overwrite Existing Tags" (off by default)
- [ ] Settings saved to `%APPDATA%/audio-pipeline/settings.json`
- [ ] Settings persist between app launches

**Technical Notes:**
- Use `electron-store` for settings persistence
- Naming templates: support {artist}, {title}, {album}, {year} placeholders
- Settings schema validation to prevent invalid configurations

---

### Feature 12: Performance Optimization and Caching
**Priority:** Low  
**Status:** Not Started

**Description:**
Optimize for large libraries: cache fingerprints, batch API calls, parallelize I/O operations. Target: 1000 files processed in <30 minutes.

**Acceptance Criteria:**
- [ ] SQLite database caches: file hash → fingerprint → MusicBrainz ID → metadata
- [ ] Repeated processing of same file uses cached results (instant)
- [ ] Skip fingerprinting if file hash + duration match cached entry
- [ ] Batch MusicBrainz requests where possible (single API call for multiple recordings)
- [ ] Disk I/O parallelized (read multiple files concurrently)
- [ ] Performance test: 1000 previously unprocessed files complete in <30 minutes
- [ ] Memory usage profiling confirms no leaks

**Technical Notes:**
- Use `better-sqlite3` for caching (fast, embedded, no server)
- File hash: SHA-256 of first 1MB + last 1MB (fast, collision-resistant)
- Cache expiration: never (metadata doesn't change), or user-triggered "Clear Cache"

---

## Technical Requirements

- **Language/Framework:** TypeScript, Node.js 20+, Electron 28+
- **Testing:** Jest with TypeScript support, 80%+ code coverage
- **Build:** `npm run build` compiles TypeScript, `npm run package` creates Windows installer
- **Linting:** ESLint + Prettier with strict rules
- **Dependencies:** All free/open-source libraries, no paid APIs

## Completion Marker

When all features are implemented, tested, and the app successfully processes a sample library of 100+ files with >95% accuracy, add **"<promise>PROJECT COMPLETE</promise>"** to DEVELOPMENT-LOG.md.

## Success Metrics

- **Accuracy:** >95% correct song identification on diverse music library
- **Speed:** <5 seconds per file average (including API calls)
- **Reliability:** Processes 1000+ file batch without crashes
- **Usability:** Non-technical users can operate GUI without documentation
