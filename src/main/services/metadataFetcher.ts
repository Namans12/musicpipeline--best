/**
 * MusicBrainz Metadata Fetching Service
 *
 * Fetches comprehensive song metadata (artist, title, album, year, genre)
 * from MusicBrainz using RecordingIDs obtained from AcoustID fingerprinting.
 * Implements rate limiting (1 req/sec for unauthenticated), retry with
 * exponential backoff, and caching.
 */

import axios from 'axios';
import { MusicBrainzMetadata } from '../../shared/types';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Interface for metadata cache (satisfied by both in-memory and persistent versions) */
export interface IMetadataCache {
  has(recordingId: string): boolean;
  get(recordingId: string): MusicBrainzMetadata | undefined;
  set(recordingId: string, metadata: MusicBrainzMetadata): void;
  delete(recordingId: string): boolean;
  clear(): void;
  readonly size: number;
}

/** Artist credit entry from MusicBrainz API */
interface MBArtistCredit {
  name: string;
  joinphrase?: string;
  artist: {
    id: string;
    name: string;
    'sort-name'?: string;
    disambiguation?: string;
  };
}

/** Release (album) entry from MusicBrainz API */
interface MBRelease {
  id: string;
  title: string;
  date?: string;
  country?: string;
  status?: string;
  'release-group'?: {
    id: string;
    'primary-type'?: string;
  };
}

/** Tag entry from MusicBrainz API */
interface MBTag {
  name: string;
  count: number;
}

/** MusicBrainz Recording API response */
export interface MBRecordingResponse {
  id: string;
  title: string;
  'artist-credit'?: MBArtistCredit[];
  releases?: MBRelease[];
  tags?: MBTag[];
  length?: number;
  disambiguation?: string;
}

/** Options for the metadata fetcher service */
export interface MetadataFetcherOptions {
  /** MusicBrainz API base URL (for testing) */
  apiBaseUrl?: string;
  /** Maximum number of retries for API calls */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff */
  baseRetryDelay?: number;
  /** User-Agent string (MusicBrainz requires a descriptive User-Agent) */
  userAgent?: string;
  /** Minimum tag vote count to include genre tag */
  minTagCount?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MUSICBRAINZ_API_URL = 'https://musicbrainz.org/ws/2';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY = 1000; // 1 second
const DEFAULT_USER_AGENT = 'AudioPipeline/1.0.0 (https://github.com/audio-pipeline)';
const DEFAULT_MIN_TAG_COUNT = 1;

/** MusicBrainz rate limit: 1 request per second for unauthenticated */
const MUSICBRAINZ_RATE_LIMIT_INTERVAL = 1100; // slightly over 1s to be safe

// ─── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * FIFO queue-based rate limiter for MusicBrainz API (1 request per second).
 *
 * Uses the same drain-queue approach as the AcoustID RateLimiter so that
 * concurrent callers are serialised and never burst past the API limit,
 * regardless of how many workers call waitForSlot() simultaneously.
 */
export class MusicBrainzRateLimiter {
  private lastRequestTime = 0;
  private readonly intervalMs: number;
  private readonly waitQueue: Array<() => void> = [];
  private isDraining = false;

  constructor(intervalMs: number = MUSICBRAINZ_RATE_LIMIT_INTERVAL) {
    this.intervalMs = intervalMs;
  }

  /**
   * Waits until the next request slot is available.
   * All concurrent callers are queued and released in FIFO order.
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

// ─── Metadata Cache ─────────────────────────────────────────────────────────

/**
 * In-memory cache for MusicBrainz metadata results.
 * Keyed by MusicBrainz Recording ID to avoid duplicate API calls.
 */
export class MetadataCache implements IMetadataCache {
  private cache: Map<string, MusicBrainzMetadata> = new Map();

  /** Check if a recording's metadata is cached */
  has(recordingId: string): boolean {
    return this.cache.has(recordingId);
  }

  /** Get cached metadata for a recording */
  get(recordingId: string): MusicBrainzMetadata | undefined {
    return this.cache.get(recordingId);
  }

  /** Store metadata for a recording */
  set(recordingId: string, metadata: MusicBrainzMetadata): void {
    this.cache.set(recordingId, metadata);
  }

  /** Remove a recording from the cache */
  delete(recordingId: string): boolean {
    return this.cache.delete(recordingId);
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

// ─── Axios Error Detection ──────────────────────────────────────────────────

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

// ─── Artist Parsing ─────────────────────────────────────────────────────────

/**
 * Extracts the primary artist name and featured artists from MusicBrainz
 * artist-credit array. The first credit is considered the primary artist;
 * subsequent credits joined with "feat." or similar are featured artists.
 *
 * @param artistCredits - Array of artist credit objects from MusicBrainz
 * @returns Object with primary artist name and array of featured artist names
 */
export function parseArtistCredits(artistCredits: MBArtistCredit[] | undefined): {
  artist: string;
  featuredArtists: string[];
} {
  if (!artistCredits || artistCredits.length === 0) {
    return { artist: 'Unknown Artist', featuredArtists: [] };
  }

  // Primary artist is the first credit
  const primaryArtist = artistCredits[0].name || artistCredits[0].artist.name;

  // Featured artists are subsequent credits
  const featuredArtists: string[] = [];
  for (let i = 1; i < artistCredits.length; i++) {
    const credit = artistCredits[i];
    const name = credit.name || credit.artist.name;
    if (name) {
      featuredArtists.push(name);
    }
  }

  return { artist: primaryArtist, featuredArtists };
}

// ─── Release Selection ──────────────────────────────────────────────────────

/**
 * Selects the best release (album) from a list of releases.
 * Prefers official albums, then considers release date and country.
 *
 * @param releases - Array of release objects from MusicBrainz
 * @returns The selected release, or undefined if no releases
 */
export function selectBestRelease(releases: MBRelease[] | undefined): MBRelease | undefined {
  if (!releases || releases.length === 0) {
    return undefined;
  }

  // Sort releases by preference:
  // 1. Official status first
  // 2. Albums over singles/EPs
  // 3. Earliest date
  // 4. With a date over without
  const sorted = [...releases].sort((a, b) => {
    // Prefer official releases
    const aOfficial = a.status === 'Official' ? 0 : 1;
    const bOfficial = b.status === 'Official' ? 0 : 1;
    if (aOfficial !== bOfficial) return aOfficial - bOfficial;

    // Prefer albums over other types
    const aAlbum = a['release-group']?.['primary-type'] === 'Album' ? 0 : 1;
    const bAlbum = b['release-group']?.['primary-type'] === 'Album' ? 0 : 1;
    if (aAlbum !== bAlbum) return aAlbum - bAlbum;

    // Prefer releases with dates
    const aHasDate = a.date ? 0 : 1;
    const bHasDate = b.date ? 0 : 1;
    if (aHasDate !== bHasDate) return aHasDate - bHasDate;

    // Earlier date first
    if (a.date && b.date) {
      return a.date.localeCompare(b.date);
    }

    return 0;
  });

  return sorted[0];
}

/**
 * Extracts the year from a MusicBrainz date string.
 * MusicBrainz dates can be "YYYY", "YYYY-MM", or "YYYY-MM-DD".
 *
 * @param dateStr - Date string from MusicBrainz
 * @returns The year as a number, or null if invalid/missing
 */
export function extractYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;

  const yearMatch = dateStr.match(/^(\d{4})/);
  if (!yearMatch) return null;

  const year = parseInt(yearMatch[1], 10);
  if (isNaN(year) || year < 1000 || year > 9999) return null;

  return year;
}

// ─── Genre/Tag Extraction ───────────────────────────────────────────────────

/**
 * Extracts genre tags from MusicBrainz tag list.
 * Filters by minimum vote count and capitalizes names.
 *
 * @param tags - Array of tag objects from MusicBrainz
 * @param minCount - Minimum vote count to include a tag
 * @returns Array of genre strings, sorted by popularity
 */
export function extractGenres(
  tags: MBTag[] | undefined,
  minCount: number = DEFAULT_MIN_TAG_COUNT,
): string[] {
  if (!tags || tags.length === 0) return [];

  return tags
    .filter((tag) => tag.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .map((tag) => capitalizeGenre(tag.name));
}

/**
 * Capitalizes a genre name.
 * Handles common genre formats like "hip hop" -> "Hip Hop",
 * "r&b" -> "R&B", "post-punk" -> "Post-Punk".
 */
function capitalizeGenre(genre: string): string {
  return genre
    .split(/(\s+|-|&)/)
    .map((part) => {
      if (part === '&' || part === '-' || /^\s+$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
}

// ─── API Query ──────────────────────────────────────────────────────────────

/**
 * Queries the MusicBrainz API for recording metadata.
 *
 * Implements retry with exponential backoff for transient failures.
 * Includes releases, artist-credits, and tags in the response.
 *
 * @param recordingId - MusicBrainz Recording ID
 * @param options - Metadata fetcher options
 * @param rateLimiter - Rate limiter instance
 * @returns The raw MusicBrainz recording response
 * @throws Error if all retries fail
 */
export async function queryMusicBrainz(
  recordingId: string,
  options: MetadataFetcherOptions,
  rateLimiter: MusicBrainzRateLimiter,
): Promise<MBRecordingResponse> {
  const apiUrl = options.apiBaseUrl || MUSICBRAINZ_API_URL;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseRetryDelay ?? DEFAULT_BASE_RETRY_DELAY;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;

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
      const response = await axios.get<MBRecordingResponse>(`${apiUrl}/recording/${recordingId}`, {
        params: {
          inc: 'releases+artist-credits+tags',
          fmt: 'json',
        },
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        timeout: 10000, // 10 second HTTP timeout
      });

      return response.data;
    } catch (error: unknown) {
      if (isAxiosLikeError(error)) {
        const status = error.response?.status;

        // Don't retry on 404 (recording not found)
        if (status === 404) {
          throw new Error(`MusicBrainz recording not found: ${recordingId}`);
        }

        // Don't retry on other 4xx client errors (except 429)
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw new Error(`MusicBrainz API error (${status}) for recording ${recordingId}`);
        }

        // 5xx, 429, and network errors are retryable
        lastError = new Error(`MusicBrainz API request failed: ${error.message}`);
      } else if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }

      // If this was the last attempt, throw
      if (attempt === maxRetries) {
        throw new Error(
          `MusicBrainz API request failed after ${maxRetries + 1} attempts for recording ${recordingId}: ${lastError.message}`,
        );
      }
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('MusicBrainz API request failed');
}

// ─── Response Mapping ───────────────────────────────────────────────────────

/**
 * Maps a raw MusicBrainz recording response to our MusicBrainzMetadata interface.
 *
 * @param response - Raw MusicBrainz API response
 * @param minTagCount - Minimum tag vote count to include genre tags
 * @returns Structured MusicBrainzMetadata object
 */
export function mapResponseToMetadata(
  response: MBRecordingResponse,
  minTagCount: number = DEFAULT_MIN_TAG_COUNT,
): MusicBrainzMetadata {
  const { artist, featuredArtists } = parseArtistCredits(response['artist-credit']);
  const bestRelease = selectBestRelease(response.releases);
  const genres = extractGenres(response.tags, minTagCount);

  return {
    recordingId: response.id,
    releaseId: bestRelease?.id ?? null,
    title: response.title,
    artist,
    featuredArtists,
    album: bestRelease?.title ?? null,
    year: bestRelease ? extractYear(bestRelease.date) : null,
    genres,
  };
}

// ─── Main Service ────────────────────────────────────────────────────────────

/**
 * Fetches metadata for a single MusicBrainz recording.
 *
 * This is the main entry point for metadata fetching. It:
 * 1. Checks the cache for existing results
 * 2. Queries MusicBrainz API with the RecordingID
 * 3. Maps the response to our MusicBrainzMetadata interface
 * 4. Caches and returns the results
 *
 * @param recordingId - MusicBrainz Recording ID
 * @param options - Metadata fetcher configuration options
 * @param cache - Optional MetadataCache instance for caching
 * @param rateLimiter - Optional MusicBrainzRateLimiter instance for rate limiting
 * @returns A promise resolving to MusicBrainzMetadata
 * @throws Error if metadata fetch fails
 */
export async function fetchRecordingMetadata(
  recordingId: string,
  options: MetadataFetcherOptions = {},
  cache?: IMetadataCache,
  rateLimiter?: MusicBrainzRateLimiter,
): Promise<MusicBrainzMetadata> {
  // Check cache first
  if (cache?.has(recordingId)) {
    return cache.get(recordingId)!;
  }

  // Query MusicBrainz API
  const limiter = rateLimiter || new MusicBrainzRateLimiter();
  const response = await queryMusicBrainz(recordingId, options, limiter);

  // Map response to our metadata interface
  const minTagCount = options.minTagCount ?? DEFAULT_MIN_TAG_COUNT;
  const metadata = mapResponseToMetadata(response, minTagCount);

  // Cache results
  if (cache) {
    cache.set(recordingId, metadata);
  }

  return metadata;
}

/**
 * Fetches metadata for the best recording from a list of recording IDs.
 *
 * Tries each recording ID in order until one succeeds. This is useful
 * when AcoustID returns multiple possible recording IDs for a fingerprint.
 *
 * @param recordingIds - Array of MusicBrainz Recording IDs to try
 * @param options - Metadata fetcher configuration options
 * @param cache - Optional MetadataCache instance for caching
 * @param rateLimiter - Optional MusicBrainzRateLimiter instance for rate limiting
 * @returns A promise resolving to MusicBrainzMetadata, or null if all fail
 */
export async function fetchBestMetadata(
  recordingIds: string[],
  options: MetadataFetcherOptions = {},
  cache?: IMetadataCache,
  rateLimiter?: MusicBrainzRateLimiter,
): Promise<MusicBrainzMetadata | null> {
  if (recordingIds.length === 0) return null;

  const limiter = rateLimiter || new MusicBrainzRateLimiter();
  const sharedCache = cache || new MetadataCache();

  for (const recordingId of recordingIds) {
    try {
      const metadata = await fetchRecordingMetadata(recordingId, options, sharedCache, limiter);
      return metadata;
    } catch {
      // Try next recording ID
      continue;
    }
  }

  return null;
}

/**
 * Fetches metadata for multiple recording IDs in batch.
 *
 * Processes recording IDs sequentially to respect MusicBrainz rate limits.
 * Failures for individual recordings are captured per-recording without
 * stopping the batch.
 *
 * @param recordingIds - Array of MusicBrainz Recording IDs
 * @param options - Metadata fetcher configuration options
 * @param cache - Optional shared MetadataCache instance
 * @returns Array of results, each containing the recording ID and either metadata or an error
 */
export async function fetchMultipleRecordings(
  recordingIds: string[],
  options: MetadataFetcherOptions = {},
  cache?: MetadataCache,
): Promise<
  Array<{
    recordingId: string;
    metadata: MusicBrainzMetadata | null;
    error: string | null;
  }>
> {
  const sharedCache = cache || new MetadataCache();
  const sharedLimiter = new MusicBrainzRateLimiter();
  const output: Array<{
    recordingId: string;
    metadata: MusicBrainzMetadata | null;
    error: string | null;
  }> = [];

  for (const recordingId of recordingIds) {
    try {
      const metadata = await fetchRecordingMetadata(
        recordingId,
        options,
        sharedCache,
        sharedLimiter,
      );
      output.push({ recordingId, metadata, error: null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.push({ recordingId, metadata: null, error: message });
    }
  }

  return output;
}
