/**
 * Batch Processing Service with Concurrency Control
 *
 * Processes large audio libraries efficiently with configurable concurrency.
 * Orchestrates the full pipeline: fingerprint -> metadata -> lyrics -> write tags -> rename.
 * Respects API rate limits (AcoustID: 3/sec, MusicBrainz: 1/sec) using a shared
 * queue system to ensure limits are never exceeded even under concurrency.
 *
 * Key design decisions:
 * - Token bucket rate limiting for shared API access across concurrent workers
 * - Configurable concurrency (1-10, default: 5)
 * - Graceful cancellation (finishes current file, then stops)
 * - Per-file error isolation (one failure doesn't stop the batch)
 * - Progress callbacks for UI integration
 * - Memory-efficient: processes files as a stream, not all at once
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  ProcessingResult,
  ProgressUpdate,
  MusicBrainzMetadata,
  FingerprintResult,
  AppSettings,
  DEFAULT_SETTINGS,
} from '../../shared/types';
import { readAudioFile } from './audioReader';
import {
  fingerprintFile,
  FingerprintCache,
  RateLimiter,
  FingerprinterOptions,
} from './fingerprinter';
import {
  fetchBestMetadata,
  MetadataCache,
  MusicBrainzRateLimiter,
  MetadataFetcherOptions,
} from './metadataFetcher';
import { fetchLyrics, LyricsCache, LyricsFetcherOptions } from './lyricsFetcher';
import { writeTagsAndRename, WriteTagsInput, WriteTagsOptions, RenameOptions } from './tagWriter';
import { Logger } from './logger';
import { wrapError } from './errors';
import {
  fetchAlbumArt,
  fetchAlbumArtFromUrl,
  fetchAlbumArtFromDeezer,
  fetchAlbumArtFromAudioDB,
  searchCAAByNames,
  FifoRateLimiter,
  AlbumArtResult,
} from './albumArtFetcher';
import { searchItunes, extractSearchTerms, ItunesRateLimiter } from './itunesFetcher';
import {
  searchSpotify,
  SpotifyRateLimiter,
  SpotifyTokenManager,
  SpotifySearchTerms,
} from './spotifyFetcher';
import { GeniusRateLimiter } from './geniusFetcher';
import {
  PersistentCacheDatabase,
  PersistentFingerprintCache,
  PersistentMetadataCache,
  PersistentLyricsCache,
} from './persistentCache';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Options for the batch processor */
export interface BatchProcessorOptions {
  /** Number of files to process concurrently (1-10, default: 5) */
  concurrency?: number;
  /** AcoustID API key (required for fingerprinting) */
  acoustIdApiKey?: string;
  /** Path to fpcalc binary */
  fpcalcPath?: string;
  /** Application settings */
  settings?: AppSettings;
  /** Logger instance for structured logging */
  logger?: Logger;
  /** Callback for progress updates */
  onProgress?: (update: ProgressUpdate) => void;
  /** Callback for individual file completion */
  onFileComplete?: (result: ProcessingResult) => void;
  /** Options for fingerprinter service (for testing) */
  fingerprinterOptions?: FingerprinterOptions;
  /** Options for metadata fetcher service (for testing) */
  metadataFetcherOptions?: MetadataFetcherOptions;
  /** Options for lyrics fetcher service (for testing) */
  lyricsFetcherOptions?: LyricsFetcherOptions;
  /** Options for tag writer */
  writeTagsOptions?: WriteTagsOptions;
  /** Options for file renaming */
  renameOptions?: RenameOptions;
}

/** Internal state for tracking batch progress */
interface BatchState {
  totalFiles: number;
  processedFiles: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  currentFiles: Set<string>;
  startTime: number;
  cancelled: boolean;
}

// ─── Token Bucket Rate Limiter ───────────────────────────────────────────────

/**
 * Token bucket rate limiter for controlling API request rates.
 * Supports concurrent consumers waiting for tokens.
 * Each consumer calls `acquire()` which resolves when a token is available.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private lastRefillTime: number;
  private waitQueue: Array<() => void> = [];
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param maxTokensPerSecond - Maximum requests per second
   * @param burstSize - Maximum burst size (tokens available at once). Defaults to 1.
   */
  constructor(maxTokensPerSecond: number, burstSize: number = 1) {
    this.maxTokens = burstSize;
    this.tokens = burstSize;
    this.refillIntervalMs = 1000 / maxTokensPerSecond;
    this.lastRefillTime = Date.now();
  }

  /**
   * Attempts to refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefillTime = now;
    }
  }

  /**
   * Acquires a token, waiting if necessary.
   * Returns a promise that resolves when a token is consumed.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    // No tokens available - wait for one
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);

      // Set up a timer to check for token availability
      if (!this.refillTimer) {
        this.refillTimer = setInterval(() => {
          this.refill();
          while (this.tokens > 0 && this.waitQueue.length > 0) {
            this.tokens--;
            const next = this.waitQueue.shift()!;
            next();
          }
          if (this.waitQueue.length === 0 && this.refillTimer) {
            clearInterval(this.refillTimer);
            this.refillTimer = null;
          }
        }, Math.ceil(this.refillIntervalMs));
      }
    });
  }

  /**
   * Returns the number of waiters in the queue.
   */
  get pendingCount(): number {
    return this.waitQueue.length;
  }

  /**
   * Returns the current number of available tokens.
   */
  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Stops the refill timer and rejects all pending waiters.
   */
  destroy(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    // Resolve all pending waiters so they can exit
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next();
    }
  }
}

// ─── Batch Processor ─────────────────────────────────────────────────────────

/**
 * Processes audio files in batch with configurable concurrency.
 *
 * Orchestrates the full pipeline for each file:
 * 1. Read existing metadata
 * 2. Generate fingerprint via fpcalc + query AcoustID
 * 3. Fetch metadata from MusicBrainz
 * 4. Fetch lyrics (if enabled in settings)
 * 5. Write corrected tags + rename file
 *
 * Concurrent file processing uses shared rate limiters to ensure
 * API limits are never exceeded.
 */
export class BatchProcessor {
  private readonly concurrency: number;
  private readonly settings: AppSettings;
  private readonly logger: Logger | null;
  private readonly onProgress: ((update: ProgressUpdate) => void) | null;
  private readonly onFileComplete: ((result: ProcessingResult) => void) | null;

  // Persistent cache database (null if using in-memory caches)
  private readonly persistentDb: PersistentCacheDatabase | null;

  // Shared caches across all concurrent workers
  private readonly fingerprintCache: FingerprintCache | PersistentFingerprintCache;
  private readonly metadataCache: MetadataCache | PersistentMetadataCache;
  private readonly lyricsCache: LyricsCache | PersistentLyricsCache;

  // Shared rate limiters for API access
  private readonly acoustIdRateLimiter: RateLimiter;
  private readonly musicBrainzRateLimiter: MusicBrainzRateLimiter;
  /** Separate MB limiter for CAA two-step art lookups so art searches
   *  don’t compete with ongoing metadata fetches in Step 3. */
  private readonly musicBrainzArtLimiter: MusicBrainzRateLimiter;
  private readonly itunesRateLimiter: ItunesRateLimiter;
  private readonly spotifyRateLimiter: SpotifyRateLimiter;
  private readonly deezerArtLimiter: FifoRateLimiter;
  private readonly audioDbArtLimiter: FifoRateLimiter;
  /** In-memory deduplication cache — prevents concurrent workers from
   *  independently fetching art for the same album. Keyed by
   *  `${artist.toLowerCase()}:${album.toLowerCase()}`. */
  private readonly albumArtCache = new Map<string, Promise<AlbumArtResult | null>>();
  // Shared Spotify token manager (handles refresh automatically)
  private readonly spotifyTokenManager: SpotifyTokenManager | null;
  // Shared Genius rate limiter for lyrics fetching
  private readonly geniusRateLimiter: GeniusRateLimiter;

  // Service options
  private readonly fingerprinterOptions: FingerprinterOptions;
  private readonly metadataFetcherOptions: MetadataFetcherOptions;
  private readonly lyricsFetcherOptions: LyricsFetcherOptions;
  private readonly writeTagsOptions: WriteTagsOptions;
  private readonly renameOptions: RenameOptions;

  // Batch state
  private state: BatchState | null = null;

  constructor(options: BatchProcessorOptions = {}) {
    // Validate and clamp concurrency
    const rawConcurrency = options.concurrency ?? DEFAULT_SETTINGS.concurrency;
    this.concurrency = Math.max(1, Math.min(10, rawConcurrency));

    this.settings = options.settings ?? { ...DEFAULT_SETTINGS };
    this.logger = options.logger ?? null;
    this.onProgress = options.onProgress ?? null;
    this.onFileComplete = options.onFileComplete ?? null;

    // Initialize caches (persistent or in-memory based on settings)
    if (this.settings.usePersistentCache) {
      this.persistentDb = new PersistentCacheDatabase();
      this.persistentDb.initialize();
      this.fingerprintCache = new PersistentFingerprintCache(this.persistentDb);
      this.metadataCache = new PersistentMetadataCache(this.persistentDb);
      this.lyricsCache = new PersistentLyricsCache(this.persistentDb);
      this.logger?.info('Initialized persistent cache (SQLite)');
    } else {
      this.persistentDb = null;
      this.fingerprintCache = new FingerprintCache();
      this.metadataCache = new MetadataCache();
      this.lyricsCache = new LyricsCache();
      this.logger?.info('Initialized in-memory caches');
    }

    // Initialize shared rate limiters
    // AcoustID: 3 requests/second -> ~334ms between requests
    this.acoustIdRateLimiter = new RateLimiter(334);
    // MusicBrainz (metadata): 1 request/second -> 1100ms
    this.musicBrainzRateLimiter = new MusicBrainzRateLimiter(1100);
    // MusicBrainz (art lookups): separate limiter so it doesn't delay metadata
    this.musicBrainzArtLimiter = new MusicBrainzRateLimiter(1100);
    // iTunes Search: ~40 requests/minute -> 1500ms between requests
    this.itunesRateLimiter = new ItunesRateLimiter(1500);
    // Spotify: ~3 requests/second -> 334ms between requests
    this.spotifyRateLimiter = new SpotifyRateLimiter(334);
    // Deezer album art: conservative ~3 req/sec -> 300ms between requests
    this.deezerArtLimiter = new FifoRateLimiter(300);
    // AudioDB album art: conservative ~2 req/sec -> 500ms between requests
    this.audioDbArtLimiter = new FifoRateLimiter(500);
    // Genius: ~30 requests/minute -> 2000ms between requests
    this.geniusRateLimiter = new GeniusRateLimiter(2000);
    // Only create the token manager when credentials are configured
    if (
      this.settings.useSpotify &&
      this.settings.spotifyClientId &&
      this.settings.spotifyClientSecret
    ) {
      this.spotifyTokenManager = new SpotifyTokenManager(
        this.settings.spotifyClientId,
        this.settings.spotifyClientSecret,
      );
    } else {
      this.spotifyTokenManager = null;
    }

    // Service options
    this.fingerprinterOptions = options.fingerprinterOptions ?? {
      apiKey: options.acoustIdApiKey ?? '',
      fpcalcPath: options.fpcalcPath,
    };
    this.metadataFetcherOptions = options.metadataFetcherOptions ?? {};
    // Build lyrics fetcher options — thread Genius credentials from settings
    const baseLyricsOptions = options.lyricsFetcherOptions ?? {};
    this.lyricsFetcherOptions = {
      ...baseLyricsOptions,
      geniusRateLimiter: baseLyricsOptions.geniusRateLimiter ?? this.geniusRateLimiter,
      geniusAccessToken:
        baseLyricsOptions.geniusAccessToken ??
        (this.settings.useGenius ? this.settings.geniusAccessToken : undefined),
      skipGenius: baseLyricsOptions.skipGenius ?? !this.settings.useGenius,
    };
    this.writeTagsOptions = options.writeTagsOptions ?? {
      overwriteAll: this.settings.overwriteExistingTags,
    };
    this.renameOptions = options.renameOptions ?? {
      outputDir: this.settings.outputFolder,
    };
  }

  /**
   * Returns the configured concurrency level.
   */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Returns the current batch state, or null if not processing.
   */
  getState(): BatchState | null {
    return this.state ? { ...this.state, currentFiles: new Set(this.state.currentFiles) } : null;
  }

  /**
   * Returns whether the processor is currently running.
   */
  isRunning(): boolean {
    return this.state !== null && !this.state.cancelled;
  }

  /**
   * Cancels the current batch processing.
   * Files currently being processed will finish, but no new files will start.
   */
  cancel(): void {
    if (this.state) {
      this.state.cancelled = true;
      this.logger?.info('Batch processing cancelled by user');
    }
  }

  /**
   * Returns a progress update snapshot.
   */
  private createProgressUpdate(currentFile: string | null): ProgressUpdate {
    if (!this.state) {
      return {
        totalFiles: 0,
        processedFiles: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        currentFile: null,
        estimatedTimeRemaining: null,
      };
    }

    const { totalFiles, processedFiles, successCount, errorCount, skippedCount, startTime } =
      this.state;

    // Calculate ETA
    let estimatedTimeRemaining: number | null = null;
    if (processedFiles > 0) {
      const elapsedMs = Date.now() - startTime;
      const avgTimePerFile = elapsedMs / processedFiles;
      const remainingFiles = totalFiles - processedFiles;
      estimatedTimeRemaining = Math.round((remainingFiles * avgTimePerFile) / 1000);
    }

    return {
      totalFiles,
      processedFiles,
      successCount,
      errorCount,
      skippedCount,
      currentFile,
      estimatedTimeRemaining,
    };
  }

  /**
   * Emits a progress update via the callback.
   */
  private emitProgress(currentFile: string | null): void {
    if (this.onProgress) {
      this.onProgress(this.createProgressUpdate(currentFile));
    }
  }

  /**
   * Processes a batch of audio files with concurrency control.
   *
   * @param filePaths - Array of absolute paths to audio files
   * @returns Array of ProcessingResult, one per file
   */
  async process(filePaths: string[]): Promise<ProcessingResult[]> {
    if (filePaths.length === 0) {
      return [];
    }

    // Initialize batch state
    this.state = {
      totalFiles: filePaths.length,
      processedFiles: 0,
      successCount: 0,
      errorCount: 0,
      skippedCount: 0,
      currentFiles: new Set(),
      startTime: Date.now(),
      cancelled: false,
    };

    this.logger?.info(
      `Starting batch processing: ${filePaths.length} files, concurrency: ${this.concurrency}`,
    );

    // Emit initial progress
    this.emitProgress(null);

    const results: ProcessingResult[] = [];
    const resultMap = new Map<number, ProcessingResult>();

    // Process files with concurrency limit
    let fileIndex = 0;
    const processNext = async (): Promise<void> => {
      while (fileIndex < filePaths.length) {
        // Check for cancellation
        if (this.state!.cancelled) {
          break;
        }

        const currentIndex = fileIndex++;
        const filePath = filePaths[currentIndex];

        // Track current file
        this.state!.currentFiles.add(filePath);
        this.emitProgress(path.basename(filePath));

        try {
          const result = await this.processFile(filePath);
          resultMap.set(currentIndex, result);

          // Update counters
          this.state!.processedFiles++;
          if (result.status === 'completed') {
            this.state!.successCount++;
          } else if (result.status === 'error') {
            this.state!.errorCount++;
          } else if (result.status === 'skipped') {
            this.state!.skippedCount++;
          }

          // Emit callbacks
          this.onFileComplete?.(result);
          this.emitProgress(
            this.state!.currentFiles.size > 0
              ? path.basename([...this.state!.currentFiles][0])
              : null,
          );
        } catch (error: unknown) {
          // Should not happen (processFile catches all errors), but just in case
          const message = error instanceof Error ? error.message : String(error);
          const result: ProcessingResult = {
            originalPath: filePath,
            newPath: null,
            status: 'error',
            error: message,
            originalMetadata: null,
            correctedMetadata: null,
          };
          resultMap.set(currentIndex, result);
          this.state!.processedFiles++;
          this.state!.errorCount++;
          this.onFileComplete?.(result);
        } finally {
          this.state!.currentFiles.delete(filePath);
        }
      }
    };

    // Launch concurrent workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(this.concurrency, filePaths.length); i++) {
      workers.push(processNext());
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    // Build results array in original order
    for (let i = 0; i < filePaths.length; i++) {
      if (resultMap.has(i)) {
        results.push(resultMap.get(i)!);
      } else {
        // File was not processed (cancelled)
        results.push({
          originalPath: filePaths[i],
          newPath: null,
          status: 'skipped',
          error: 'Processing cancelled',
          originalMetadata: null,
          correctedMetadata: null,
        });
      }
    }

    // Log summary
    const elapsed = Date.now() - this.state.startTime;
    this.logger?.info(
      `Batch processing complete: ${this.state.successCount} succeeded, ${this.state.errorCount} errors, ${this.state.skippedCount} skipped in ${(elapsed / 1000).toFixed(1)}s`,
    );

    // Emit final progress
    this.emitProgress(null);

    // Clear state
    this.state = null;

    return results;
  }

  /**
   * Processes a single audio file through the full pipeline.
   *
   * Steps:
   * 1. Read existing metadata
   * 2. Fingerprint + AcoustID lookup
   * 3. MusicBrainz metadata fetch
   * 4. Lyrics fetch (if enabled)
   * 5. Write tags + rename
   *
   * @param filePath - Absolute path to the audio file
   * @returns ProcessingResult for the file
   */
  async processFile(filePath: string): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      originalPath: filePath,
      newPath: null,
      status: 'pending',
      error: null,
      originalMetadata: null,
      correctedMetadata: null,
    };

    try {
      // Step 1: Read existing metadata
      result.status = 'fingerprinting'; // status progression
      this.logger?.info(`Processing: ${path.basename(filePath)}`, {
        filePath,
        step: 'reading',
      });

      try {
        result.originalMetadata = await readAudioFile(filePath);
      } catch (error: unknown) {
        const wrapped = wrapError(error, 'FileReadError', {
          filePath,
          step: 'reading',
        });
        this.logger?.logError(wrapped);
        result.status = 'error';
        result.error = `Failed to read file: ${wrapped.message}`;
        result.failedStep = 'reading';
        return result;
      }

      // Step 2: Fingerprint and identify via AcoustID
      result.status = 'fingerprinting';
      this.logger?.info(`Fingerprinting: ${path.basename(filePath)}`, {
        filePath,
        step: 'fingerprinting',
      });

      let fingerprintResults: FingerprintResult[];
      try {
        fingerprintResults = await fingerprintFile(
          filePath,
          this.fingerprinterOptions,
          this.fingerprintCache,
          this.acoustIdRateLimiter,
        );
      } catch (error: unknown) {
        const wrapped = wrapError(error, 'FingerprintError', {
          filePath,
          step: 'fingerprinting',
        });
        this.logger?.logError(wrapped);
        result.status = 'error';
        result.error = `Fingerprinting failed: ${wrapped.message}`;
        result.failedStep = 'fingerprinting';
        return result;
      }

      const hasFingerprintMatch =
        fingerprintResults.length > 0 && fingerprintResults[0].recordingIds.length > 0;

      // Step 3: Fetch metadata from MusicBrainz (when recording IDs are available)
      result.status = 'fetching_metadata';
      this.logger?.info(`Fetching metadata: ${path.basename(filePath)}`, {
        filePath,
        step: 'fetching_metadata',
      });

      let metadata: MusicBrainzMetadata | null = null;
      let itunesArtworkUrl: string | undefined;

      if (hasFingerprintMatch) {
        const bestMatch = fingerprintResults[0];
        try {
          metadata = await fetchBestMetadata(
            bestMatch.recordingIds,
            this.metadataFetcherOptions,
            this.metadataCache,
            this.musicBrainzRateLimiter,
          );
        } catch (error: unknown) {
          const wrapped = wrapError(error, 'APIError', {
            filePath,
            step: 'fetching_metadata',
          });
          this.logger?.logError(wrapped);
          result.status = 'error';
          result.error = `Metadata fetch failed: ${wrapped.message}`;
          result.failedStep = 'fetching_metadata';
          return result;
        }
      }

      // fallback — triggered when fingerprinting found no match
      //          OR when MusicBrainz returned nothing for the matched recording IDs.
      if (!metadata && this.spotifyTokenManager) {
        const reason = !hasFingerprintMatch
          ? 'No fingerprint match found'
          : 'MusicBrainz returned no metadata';
        this.logger?.info(`${reason} — trying Spotify search as fallback`, {
          filePath,
          step: 'fetching_metadata',
        });

        const rawTerms = extractSearchTerms(result.originalMetadata, filePath);
        const spotifyTerms: SpotifySearchTerms = {
          title: rawTerms.title ?? '',
          artist: rawTerms.artist ?? undefined,
        };

        try {
          const spotifyResult = await searchSpotify(
            spotifyTerms,
            this.settings.spotifyClientId,
            this.settings.spotifyClientSecret,
            this.spotifyRateLimiter,
            this.spotifyTokenManager,
          );
          if (spotifyResult) {
            metadata = spotifyResult.metadata;
            itunesArtworkUrl = spotifyResult.artworkUrl;
            this.logger?.info(
              `Spotify: found "${metadata.title}" by ${metadata.artist}`,
              { filePath, step: 'fetching_metadata' },
            );
          }
        } catch (error: unknown) {
          this.logger?.warn(
            `Spotify search failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { filePath, step: 'fetching_metadata' },
          );
        }
      }

      // Step 3c: iTunes fallback — triggered when fingerprinting found no match
      //          OR when MusicBrainz/Spotify returned nothing.
      if (!metadata) {
        const reason = !hasFingerprintMatch
          ? 'No fingerprint match found'
          : 'MusicBrainz returned no metadata';
        this.logger?.info(`${reason} — trying iTunes search as fallback`, {
          filePath,
          step: 'fetching_metadata',
        });

        const terms = extractSearchTerms(result.originalMetadata, filePath);
        const itunesResult = await searchItunes(terms, this.itunesRateLimiter);
        if (itunesResult) {
          metadata = itunesResult.metadata;
          itunesArtworkUrl = itunesResult.artworkUrl;
          this.logger?.info(
            `iTunes: found "${metadata.title}" by ${metadata.artist}`,
            { filePath, step: 'fetching_metadata' },
          );
        }
      }

      if (!metadata) {
        this.logger?.logSkippedFile(
          filePath,
          'No metadata found in MusicBrainz or iTunes',
        );
        result.status = 'skipped';
        result.error = 'No metadata found in MusicBrainz or iTunes';
        return result;
      }

      // Step 4: Fetch album art — multi-source cascade with in-flight deduplication
      //   4a. Cover Art Archive (direct — MusicBrainz release ID already known)
      //   4b. Deezer album search (free, no auth, ~3 req/sec)
      //   4c. AudioDB album search (free tier, API key "2" in URL)
      //   4d. Cover Art Archive two-step (search MB for release ID, then CAA)
      //   4e. iTunes / Spotify CDN URL (artwork URL from search fallback)
      //
      // Deduplication: for tracks sharing the same artist+album, only the first
      // concurrent worker runs the full cascade; all others await the same Promise.
      let albumArt: { data: Buffer; mimeType: string } | undefined;

      const artCacheKey = `${metadata.artist.toLowerCase()}:${(metadata.album ?? metadata.title).toLowerCase()}`;

      const runArtCascade = async (): Promise<AlbumArtResult | null> => {
        // 4a: CAA direct (releaseId comes from MusicBrainz fingerprint match)
        if (metadata.releaseId) {
          this.logger?.info(`Fetching album art via CAA for release: ${metadata.releaseId}`, {
            filePath,
            step: 'fetching_album_art',
          });
          const artResult = await fetchAlbumArt(metadata.releaseId);
          if (artResult) return artResult;
        }

        // 4b: Deezer (artist + title, with album as primary hint when available)
        if (metadata.artist && metadata.title) {
          this.logger?.info(
            `Fetching album art via Deezer: "${metadata.artist}" – "${metadata.title}"${
              metadata.album ? ` (album: "${metadata.album}")` : ''
            }`,
            { filePath, step: 'fetching_album_art' },
          );
          const artResult = await fetchAlbumArtFromDeezer(
            metadata.artist,
            metadata.title,
            metadata.album ?? null,
            this.deezerArtLimiter,
          );
          if (artResult) return artResult;
        }

        // 4c: AudioDB (artist + album)
        if (metadata.artist && metadata.album) {
          this.logger?.info(
            `Fetching album art via AudioDB: "${metadata.artist}" – "${metadata.album}"`,
            { filePath, step: 'fetching_album_art' },
          );
          const artResult = await fetchAlbumArtFromAudioDB(
            metadata.artist,
            metadata.album,
            this.audioDbArtLimiter,
          );
          if (artResult) return artResult;
        }

        // 4d: CAA two-step — search MusicBrainz for a release ID when we don't already have one.
        //     Uses a dedicated MB rate limiter so art searches don't delay metadata fetches.
        if (!metadata.releaseId && metadata.artist && metadata.album) {
          this.logger?.info(
            `Fetching album art via CAA two-step (MB search): "${metadata.artist}" – "${metadata.album}"`,
            { filePath, step: 'fetching_album_art' },
          );
          const releaseId = await searchCAAByNames(
            metadata.artist,
            metadata.album,
            this.musicBrainzArtLimiter,
          );
          if (releaseId) {
            const artResult = await fetchAlbumArt(releaseId);
            if (artResult) return artResult;
          }
        }

        // 4e: iTunes / Spotify CDN URL (returned alongside search-fallback metadata)
        if (itunesArtworkUrl) {
          this.logger?.info('Fetching album art from CDN URL (iTunes/Spotify)', {
            filePath,
            step: 'fetching_album_art',
          });
          const artResult = await fetchAlbumArtFromUrl(itunesArtworkUrl);
          if (artResult) return artResult;
        }

        return null;
      };

      // Serve from dedup cache if the same album is already being fetched
      if (!this.albumArtCache.has(artCacheKey)) {
        this.albumArtCache.set(artCacheKey, runArtCascade());
      }
      const cachedArt = await this.albumArtCache.get(artCacheKey)!;
      if (cachedArt) albumArt = cachedArt;

      // Step 5: Fetch lyrics (if enabled)
      let lyrics: string | null = null;
      if (this.settings.fetchLyrics) {
        result.status = 'fetching_lyrics';
        this.logger?.info(`Fetching lyrics: ${metadata.artist} - ${metadata.title}`, {
          filePath,
          step: 'fetching_lyrics',
        });

        try {
          const lyricsResult = await fetchLyrics(
            metadata.artist,
            metadata.title,
            this.lyricsFetcherOptions,
            this.lyricsCache,
          );
          if (lyricsResult) {
            lyrics = lyricsResult.lyrics;
          }
        } catch (error: unknown) {
          // Lyrics are optional, so log but don't fail
          this.logger?.warn(
            `Lyrics fetch failed for ${metadata.artist} - ${metadata.title}: ${error instanceof Error ? error.message : String(error)}`,
            {
              filePath,
              step: 'fetching_lyrics',
            },
          );
        }
      }

      // Step 6: Build the corrected metadata
      const artistDisplay =
        metadata.featuredArtists.length > 0
          ? `${metadata.artist} feat. ${metadata.featuredArtists.join(', ')}`
          : metadata.artist;

      const writeInput: WriteTagsInput = {
        title: metadata.title,
        artist: artistDisplay,
        album: metadata.album ?? undefined,
        year: metadata.year ?? undefined,
        genre: metadata.genres.length > 0 ? metadata.genres : undefined,
        lyrics: lyrics ?? undefined,
        albumArt,
      };

      // Build corrected metadata for result
      result.correctedMetadata = {
        filePath: filePath,
        format: result.originalMetadata?.format ?? 'mp3',
        fileSize: result.originalMetadata?.fileSize ?? 0,
        duration: result.originalMetadata?.duration ?? 0,
        title: metadata.title,
        artist: artistDisplay,
        album: metadata.album,
        year: metadata.year,
        genre: metadata.genres.length > 0 ? metadata.genres : null,
        trackNumber: result.originalMetadata?.trackNumber ?? null,
        discNumber: result.originalMetadata?.discNumber ?? null,
        albumArtist: metadata.artist,
        lyrics: lyrics,
      };

      // Step 7: Write tags and rename
      result.status = 'writing_tags';
      this.logger?.info(`Writing tags: ${path.basename(filePath)}`, {
        filePath,
        step: 'writing_tags',
      });

      try {
        const writeResult = writeTagsAndRename(
          filePath,
          writeInput,
          this.writeTagsOptions,
          this.renameOptions,
        );

        if (!writeResult.success) {
          const wrapped = wrapError(
            new Error(writeResult.error ?? 'Unknown write error'),
            'WriteError',
            { filePath, step: 'writing_tags' },
          );
          this.logger?.logError(wrapped);
          result.status = 'error';
          result.error = `Tag writing/rename failed: ${writeResult.error}`;
          result.failedStep = 'writing_tags';
          return result;
        }

        result.newPath = writeResult.newPath;

        // ── #11: Post-write file integrity check ──────────────────────────────
        // Verify the written file is at least 50% of the original size.
        // A drastically smaller file almost certainly indicates corruption.
        const originalSize = result.originalMetadata?.fileSize ?? 0;
        if (originalSize > 0) {
          try {
            const targetPath = result.newPath ?? filePath;
            const newStat = fs.statSync(targetPath);
            if (newStat.size < originalSize * 0.5) {
              this.logger?.error(
                `Integrity check failed: file shrank from ${originalSize} to ${newStat.size} bytes`,
                { filePath, step: 'writing_tags' },
              );
              result.status = 'error';
              result.error = `File may be corrupted after tag writing (${originalSize} → ${newStat.size} bytes)`;
              result.failedStep = 'writing_tags';
              return result;
            }
          } catch {
            // stat failed — non-fatal, continue
          }
        }
      } catch (error: unknown) {
        const wrapped = wrapError(error, 'WriteError', {
          filePath,
          step: 'writing_tags',
        });
        this.logger?.logError(wrapped);
        result.status = 'error';
        result.error = `Tag writing failed: ${wrapped.message}`;
        result.failedStep = 'writing_tags';
        return result;
      }

      // Success!
      result.status = 'completed';
      this.logger?.info(
        `Completed: ${path.basename(filePath)} -> ${result.newPath ? path.basename(result.newPath) : 'tags updated'}`,
        { filePath, step: 'completed' },
      );

      return result;
    } catch (error: unknown) {
      // Catch-all for unexpected errors
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Unexpected error processing ${path.basename(filePath)}: ${message}`, {
        filePath,
        step: 'unknown',
      });
      result.status = 'error';
      result.error = `Unexpected error: ${message}`;
      result.failedStep = 'unknown';
      return result;
    }
  }

  getCacheStats(): {
    fingerprints: number;
    metadata: number;
    lyrics: number;
    totalEntries: number;
    sizeBytes: number;
    isPersistent: boolean;
  } {
    if (this.persistentDb) {
      const stats = this.persistentDb.getStats();
      return {
        ...stats,
        sizeBytes: this.persistentDb.getDatabaseSize(),
        isPersistent: true,
      };
    } else {
      return {
        fingerprints: this.fingerprintCache.size,
        metadata: this.metadataCache.size,
        lyrics: this.lyricsCache.size,
        totalEntries: this.fingerprintCache.size + this.metadataCache.size + this.lyricsCache.size,
        sizeBytes: 0,
        isPersistent: false,
      };
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    if (this.persistentDb) {
      this.persistentDb.clearAll();
      this.logger?.info('Cleared persistent cache');
    } else {
      this.fingerprintCache.clear();
      this.metadataCache.clear();
      this.lyricsCache.clear();
      this.logger?.info('Cleared in-memory caches');
    }
  }

  /**
   * Close the persistent database (if used)
   */
  close(): void {
    if (this.persistentDb && this.persistentDb.isOpen()) {
      this.persistentDb.close();
      this.logger?.info('Closed persistent cache database');
    }
  }
}

// ─── Utility: Estimate Processing Time ───────────────────────────────────────

/**
 * Estimates the total processing time for a batch of files.
 * Based on average processing time per file with API call overhead.
 *
 * @param fileCount - Number of files to process
 * @param concurrency - Concurrency level (1-10)
 * @returns Estimated time in seconds
 */
export function estimateProcessingTime(
  fileCount: number,
  concurrency: number = DEFAULT_SETTINGS.concurrency,
): number {
  if (fileCount <= 0) return 0;

  // Average time per file estimate:
  // - Fingerprinting: ~2s (fpcalc)
  // - AcoustID API: ~0.5s (with rate limit wait)
  // - MusicBrainz API: ~1.2s (with 1s rate limit)
  // - Lyrics API: ~0.5s
  // - Tag writing: ~0.1s
  // Total: ~4.3s per file sequential
  const avgTimePerFile = 4.3;

  // With concurrency, the bottleneck is the MusicBrainz rate limit (1/sec)
  // So effective throughput is limited to ~1 file/sec for the MB step
  // But fingerprinting can be parallelized
  const clampedConcurrency = Math.max(1, Math.min(10, concurrency));

  // The MusicBrainz rate limit is the bottleneck
  // Effective per-file time considering parallelism
  const effectiveTimePerFile = Math.max(
    avgTimePerFile / clampedConcurrency,
    1.2, // MusicBrainz rate limit floor
  );

  return Math.ceil(fileCount * effectiveTimePerFile);
}
