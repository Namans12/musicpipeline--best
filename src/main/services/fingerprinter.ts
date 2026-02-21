/**
 * Audio Fingerprinting Service
 *
 * Generates audio fingerprints using fpcalc (Chromaprint) and queries the
 * AcoustID API to identify songs. Implements caching, rate limiting, and
 * retry with exponential backoff.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { FingerprintResult } from '../../shared/types';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Interface for fingerprint cache (satisfied by both in-memory and persistent versions) */
export interface IFingerprintCache {
  has(filePath: string): boolean;
  get(filePath: string): FingerprintResult[] | undefined;
  set(filePath: string, results: FingerprintResult[]): void;
  delete(filePath: string): boolean;
  clear(): void;
  readonly size: number;
}

/** Raw output from fpcalc binary */
export interface FpcalcResult {
  /** Audio duration in seconds */
  duration: number;
  /** Chromaprint fingerprint string */
  fingerprint: string;
}

/** Single recording from AcoustID response */
interface AcoustIdRecording {
  id: string;
}

/** Single result from AcoustID response */
interface AcoustIdResult {
  id: string;
  score: number;
  recordings?: AcoustIdRecording[];
}

/** AcoustID API error detail */
interface AcoustIdError {
  code: number;
  message: string;
}

/** AcoustID API response structure */
export interface AcoustIdResponse {
  status: string;
  results: AcoustIdResult[];
  /** Present when status is 'error' */
  error?: AcoustIdError;
}

/** Options for the fingerprinter service */
export interface FingerprinterOptions {
  /** AcoustID API key */
  apiKey: string;
  /** Path to fpcalc binary (auto-detected if not specified) */
  fpcalcPath?: string;
  /** AcoustID API base URL (for testing) */
  apiBaseUrl?: string;
  /** Maximum number of retries for API calls */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff */
  baseRetryDelay?: number;
  /** Minimum confidence score to include in results (0-1) */
  minScore?: number;
  /** Timeout for fpcalc execution in ms */
  fpcalcTimeout?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ACOUSTID_API_URL = 'https://api.acoustid.org/v2/lookup';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY = 1000; // 1 second
const DEFAULT_MIN_SCORE = 0.0;
const DEFAULT_FPCALC_TIMEOUT = 30000; // 30 seconds
const RATE_LIMIT_INTERVAL = 334; // ~3 requests per second

// ─── Cache ───────────────────────────────────────────────────────────────────

/**
 * In-memory cache for fingerprint results.
 * Keyed by absolute file path to avoid duplicate API calls for the same file.
 */
export class FingerprintCache implements IFingerprintCache {
  private cache: Map<string, FingerprintResult[]> = new Map();

  /** Check if a file's results are cached */
  has(filePath: string): boolean {
    return this.cache.has(path.resolve(filePath));
  }

  /** Get cached results for a file */
  get(filePath: string): FingerprintResult[] | undefined {
    return this.cache.get(path.resolve(filePath));
  }

  /** Store results for a file */
  set(filePath: string, results: FingerprintResult[]): void {
    this.cache.set(path.resolve(filePath), results);
  }

  /** Remove a file from the cache */
  delete(filePath: string): boolean {
    return this.cache.delete(path.resolve(filePath));
  }

  /** Clear all cached results */
  clear(): void {
    this.cache.clear();
  }

  /** Get the number of cached entries */
  get size(): number {
    return this.cache.size;
  }
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * FIFO queue-based rate limiter for AcoustID API calls.
 *
 * The previous gap-based approach was racy under concurrency: N workers calling
 * waitForSlot() simultaneously all observed the same gap, computed the same wait
 * time, and all fired at once.  This version serialises callers through a drain
 * loop so exactly one request is released every intervalMs, no matter how many
 * concurrent workers are waiting.
 */
export class RateLimiter {
  private lastRequestTime = 0;
  private readonly intervalMs: number;
  private readonly waitQueue: Array<() => void> = [];
  private isDraining = false;

  constructor(intervalMs: number = RATE_LIMIT_INTERVAL) {
    this.intervalMs = intervalMs;
  }

  /**
   * Waits until the next request slot is available.
   * All concurrent callers are queued and released in FIFO order with
   * at least intervalMs between consecutive releases.
   */
  waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      if (!this.isDraining) {
        void this.drain();
      }
    });
  }

  private async drain(): Promise<void> {
    this.isDraining = true;
    while (this.waitQueue.length > 0) {
      const now = Date.now();
      const remaining = this.intervalMs - (now - this.lastRequestTime);
      if (remaining > 0) {
        await new Promise<void>((r) => setTimeout(r, remaining));
      }
      this.lastRequestTime = Date.now();
      const next = this.waitQueue.shift();
      if (next) next();
    }
    this.isDraining = false;
  }
}

// ─── Fpcalc Execution ────────────────────────────────────────────────────────

/**
 * Attempts to find the fpcalc binary in common locations.
 * @returns The path to fpcalc, or 'fpcalc' to rely on PATH
 */
export function findFpcalcPath(): string {
  // Check common installation paths on Windows
  const commonPaths = [
    'fpcalc',
    'fpcalc.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Chromaprint', 'fpcalc.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Chromaprint', 'fpcalc.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Chromaprint', 'fpcalc.exe'),
  ];

  for (const fpcalcPath of commonPaths) {
    if (fpcalcPath && fpcalcPath !== 'fpcalc' && fpcalcPath !== 'fpcalc.exe') {
      try {
        if (fs.existsSync(fpcalcPath)) {
          return fpcalcPath;
        }
      } catch {
        // Skip paths that can't be accessed
      }
    }
  }

  // Fall back to relying on PATH
  return 'fpcalc';
}

/**
 * Executes fpcalc to generate an audio fingerprint for a file.
 *
 * @param filePath - Absolute path to the audio file
 * @param fpcalcPath - Path to the fpcalc binary
 * @param timeout - Timeout in milliseconds for fpcalc execution
 * @returns A promise resolving to the FpcalcResult with duration and fingerprint
 * @throws Error if fpcalc is not found or fails
 */
export function runFpcalc(
  filePath: string,
  fpcalcPath: string = 'fpcalc',
  timeout: number = DEFAULT_FPCALC_TIMEOUT,
): Promise<FpcalcResult> {
  return new Promise<FpcalcResult>((resolve, reject) => {
    // Validate the file exists
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }

    execFile(fpcalcPath, ['-json', filePath], { timeout }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error(
              `fpcalc not found at "${fpcalcPath}". Please install Chromaprint: https://acoustid.org/chromaprint`,
            ),
          );
          return;
        }
        reject(
          new Error(
            `fpcalc failed for "${path.basename(filePath)}": ${error.message}${stderr ? ` (${stderr.trim()})` : ''}`,
          ),
        );
        return;
      }

      try {
        const result = JSON.parse(stdout) as { duration: number; fingerprint: string };

        if (!result.fingerprint || typeof result.duration !== 'number') {
          reject(new Error(`fpcalc returned invalid output for "${path.basename(filePath)}"`));
          return;
        }

        resolve({
          duration: result.duration,
          fingerprint: result.fingerprint,
        });
      } catch {
        reject(
          new Error(
            `Failed to parse fpcalc output for "${path.basename(filePath)}": ${stdout.substring(0, 200)}`,
          ),
        );
      }
    });
  });
}

// ─── Axios Error Detection ───────────────────────────────────────────────────

/** Type guard for axios-like errors (works with both real and mocked axios) */
interface AxiosLikeError extends Error {
  isAxiosError: boolean;
  response?: {
    status: number;
    data?: unknown;
  };
}

function isAxiosLikeError(error: unknown): error is AxiosLikeError {
  return (
    error !== null &&
    typeof error === 'object' &&
    'isAxiosError' in error &&
    (error as { isAxiosError: unknown }).isAxiosError === true
  );
}

// ─── AcoustID API ────────────────────────────────────────────────────────────

/**
 * Queries the AcoustID API with a fingerprint to identify a song.
 *
 * Implements retry with exponential backoff for transient failures.
 * Respects rate limits of 3 requests/second.
 *
 * @param fingerprint - Chromaprint fingerprint string
 * @param duration - Audio duration in seconds
 * @param options - Fingerprinter options including API key
 * @param rateLimiter - Rate limiter instance
 * @returns A promise resolving to an array of FingerprintResult
 * @throws Error if all retries fail
 */
export async function queryAcoustId(
  fingerprint: string,
  duration: number,
  options: FingerprinterOptions,
  rateLimiter: RateLimiter,
): Promise<FingerprintResult[]> {
  const apiUrl = options.apiBaseUrl || ACOUSTID_API_URL;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseRetryDelay ?? DEFAULT_BASE_RETRY_DELAY;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: baseDelay * 2^(attempt-1)
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    // Wait for rate limit slot
    await rateLimiter.waitForSlot();

    try {
      const response = await axios.get<AcoustIdResponse>(apiUrl, {
        params: {
          client: options.apiKey,
          fingerprint,
          duration: Math.round(duration),
          meta: 'recordings',
          format: 'json',
        },
        timeout: 10000, // 10 second HTTP timeout
      });

      if (response.data.status !== 'ok') {
        const acoustIdMsg = response.data.error?.message;
        throw new Error(
          acoustIdMsg
            ? `AcoustID API error: ${acoustIdMsg}`
            : `AcoustID API returned status: ${response.data.status}`,
        );
      }

      // Map results to FingerprintResult array
      const results: FingerprintResult[] = [];

      for (const result of response.data.results) {
        if (result.score < minScore) {
          continue;
        }

        const recordingIds: string[] = [];
        if (result.recordings) {
          for (const recording of result.recordings) {
            recordingIds.push(recording.id);
          }
        }

        results.push({
          score: result.score,
          acoustId: result.id,
          recordingIds,
        });
      }

      // Sort by score descending (best matches first)
      results.sort((a, b) => b.score - a.score);

      return results;
    } catch (error: unknown) {
      if (isAxiosLikeError(error)) {
        const status = error.response?.status;

        // Don't retry client errors (except rate limit 429)
        if (status && status >= 400 && status < 500 && status !== 429) {
          const errorData = error.response?.data as { error?: { message?: string } } | undefined;
          throw new Error(
            `AcoustID API error (${status}): ${errorData?.error?.message || error.message}`,
          );
        }

        lastError = new Error(`AcoustID API request failed: ${error.message}`);
      } else if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }

      // If this was the last attempt, throw
      if (attempt === maxRetries) {
        throw new Error(
          `AcoustID API request failed after ${maxRetries + 1} attempts: ${lastError.message}`,
        );
      }
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('AcoustID API request failed');
}

// ─── Main Service ────────────────────────────────────────────────────────────

/**
 * Fingerprints an audio file and identifies it using the AcoustID API.
 *
 * This is the main entry point for audio fingerprinting. It:
 * 1. Checks the cache for existing results
 * 2. Runs fpcalc to generate a fingerprint
 * 3. Queries AcoustID with the fingerprint
 * 4. Caches and returns the results
 *
 * @param filePath - Absolute path to the audio file
 * @param options - Fingerprinter configuration options
 * @param cache - Optional FingerprintCache instance for caching
 * @param rateLimiter - Optional RateLimiter instance for rate limiting
 * @returns A promise resolving to an array of FingerprintResult sorted by score
 * @throws Error if fingerprinting or API lookup fails
 */
export async function fingerprintFile(
  filePath: string,
  options: FingerprinterOptions,
  cache?: IFingerprintCache,
  rateLimiter?: RateLimiter,
): Promise<FingerprintResult[]> {
  const resolvedPath = path.resolve(filePath);

  // Check cache first
  if (cache?.has(resolvedPath)) {
    return cache.get(resolvedPath)!;
  }

  // Step 1: Generate fingerprint using fpcalc
  const fpcalcPath = options.fpcalcPath || findFpcalcPath();
  const fpcalcTimeout = options.fpcalcTimeout ?? DEFAULT_FPCALC_TIMEOUT;
  const fpcalcResult = await runFpcalc(resolvedPath, fpcalcPath, fpcalcTimeout);

  // Step 2: Query AcoustID
  const limiter = rateLimiter || new RateLimiter();
  const results = await queryAcoustId(
    fpcalcResult.fingerprint,
    fpcalcResult.duration,
    options,
    limiter,
  );

  // Step 3: Cache results
  if (cache) {
    cache.set(resolvedPath, results);
  }

  return results;
}

/**
 * Fingerprints multiple audio files with shared cache and rate limiter.
 *
 * Processes files sequentially to respect API rate limits.
 * Failures for individual files are captured per-file without stopping the batch.
 *
 * @param filePaths - Array of absolute paths to audio files
 * @param options - Fingerprinter configuration options
 * @param cache - Optional shared FingerprintCache instance
 * @returns Array of results, each containing the file path and either results or an error
 */
export async function fingerprintMultipleFiles(
  filePaths: string[],
  options: FingerprinterOptions,
  cache?: FingerprintCache,
): Promise<
  Array<{
    filePath: string;
    results: FingerprintResult[] | null;
    error: string | null;
  }>
> {
  const sharedCache = cache || new FingerprintCache();
  const sharedLimiter = new RateLimiter();
  const output: Array<{
    filePath: string;
    results: FingerprintResult[] | null;
    error: string | null;
  }> = [];

  for (const filePath of filePaths) {
    try {
      const results = await fingerprintFile(filePath, options, sharedCache, sharedLimiter);
      output.push({ filePath, results, error: null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.push({ filePath, results: null, error: message });
    }
  }

  return output;
}
