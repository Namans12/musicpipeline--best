/**
 * Lyrics Fetching Service
 *
 * Searches for and retrieves unsynchronized lyrics (USLT) from free sources.
 * Primary source: LRCLIB API (no key required).
 * Fallback source: ChartLyrics API (free, REST).
 * Matches lyrics to identified songs using artist + title.
 * Implements caching, rate limiting, retry with exponential backoff,
 * and lyrics cleanup/validation.
 */

import axios from 'axios';
import { queryGeniusLyrics, GeniusRateLimiter } from './geniusFetcher';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Interface for lyrics cache (satisfied by both in-memory and persistent versions) */
export interface ILyricsCache {
  has(artist: string, title: string): boolean;
  get(artist: string, title: string): LyricsResult | null | undefined;
  set(artist: string, title: string, result: LyricsResult | null): void;
  delete(artist: string, title: string): boolean;
  clear(): void;
  readonly size: number;
}

/** LRCLIB API search result entry */
export interface LRCLIBResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

/** ChartLyrics API search result entry */
export interface ChartLyricsResult {
  TrackId?: number;
  LyricChecksum?: string;
  LyricId?: number;
  LyricSong?: string;
  LyricArtist?: string;
  LyricUrl?: string;
  LyricCovertArtUrl?: string;
  LyricRank?: number;
  LyricCorrectUrl?: string;
  Lyric?: string;
}

/** ChartLyrics API lyric detail response */
export interface ChartLyricsLyricResponse {
  TrackId?: number;
  LyricId?: number;
  LyricSong?: string;
  LyricArtist?: string;
  Lyric?: string;
}

/** Result of a lyrics fetch operation */
export interface LyricsResult {
  /** The plain text lyrics */
  lyrics: string;
  /** Source of the lyrics */
  source: 'lrclib' | 'chartlyrics' | 'genius';
  /** Whether the lyrics were validated against the query */
  validated: boolean;
}

/** Options for the lyrics fetcher service */
export interface LyricsFetcherOptions {
  /** LRCLIB API base URL (for testing) */
  lrclibBaseUrl?: string;
  /** ChartLyrics API base URL (for testing) */
  chartLyricsBaseUrl?: string;
  /** Genius API base URL (for testing) */
  geniusBaseUrl?: string;
  /** Genius Client Access Token (enables Genius as a lyrics source) */
  geniusAccessToken?: string;
  /** Skip the Genius fallback entirely (e.g., no token configured) */
  skipGenius?: boolean;
  /** Maximum number of retries for API calls */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff */
  baseRetryDelay?: number;
  /** HTTP request timeout in ms */
  requestTimeout?: number;
  /** User-Agent string for API requests */
  userAgent?: string;
  /** Whether to skip ChartLyrics fallback */
  skipChartLyrics?: boolean;
  /** Shared Genius rate limiter (prevents exceeding API quota across concurrent workers) */
  geniusRateLimiter?: GeniusRateLimiter;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LRCLIB_API_URL = 'https://lrclib.net/api';
const CHARTLYRICS_API_URL = 'http://api.chartlyrics.com/apiv1.asmx';
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY = 500;
const DEFAULT_REQUEST_TIMEOUT = 10000;
const DEFAULT_USER_AGENT = 'AudioPipeline/1.0.0 (https://github.com/audio-pipeline)';

// ─── Lyrics Cache ────────────────────────────────────────────────────────────

/**
 * In-memory cache for lyrics results.
 * Keyed by normalized "artist|title" string to avoid duplicate API calls.
 */
export class LyricsCache implements ILyricsCache {
  private cache: Map<string, LyricsResult | null> = new Map();

  /** Generate a normalized cache key from artist and title */
  static makeKey(artist: string, title: string): string {
    return `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`;
  }

  /** Check if lyrics for a song are cached */
  has(artist: string, title: string): boolean {
    return this.cache.has(LyricsCache.makeKey(artist, title));
  }

  /** Get cached lyrics for a song (returns undefined if not cached) */
  get(artist: string, title: string): LyricsResult | null | undefined {
    return this.cache.get(LyricsCache.makeKey(artist, title));
  }

  /** Store lyrics result for a song (null means "no lyrics found") */
  set(artist: string, title: string, result: LyricsResult | null): void {
    this.cache.set(LyricsCache.makeKey(artist, title), result);
  }

  /** Remove a song from the cache */
  delete(artist: string, title: string): boolean {
    return this.cache.delete(LyricsCache.makeKey(artist, title));
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

// ─── Lyrics Cleanup ─────────────────────────────────────────────────────────

/**
 * Cleans up raw lyrics text by removing:
 * - Extra whitespace and blank lines
 * - Common ad/copyright notices
 * - Leading/trailing whitespace
 * - Excessive consecutive blank lines (max 1 blank line between sections)
 *
 * @param rawLyrics - Raw lyrics string from API
 * @returns Cleaned lyrics string
 */
export function cleanLyrics(rawLyrics: string): string {
  if (!rawLyrics || rawLyrics.trim().length === 0) {
    return '';
  }

  let cleaned = rawLyrics;

  // Normalize line endings to \n
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Remove common ad/copyright lines (case-insensitive)
  const adPatterns: RegExp[] = [
    /^\s*\*{3,}.*$/gm,
    /^\s*-{3,}.*$/gm,
    /^\s*copyright\s*©?\s*\d{4}.*$/gim,
    /^\s*all rights reserved\.?\s*$/gim,
    /^\s*lyrics licensed &? provided by.*$/gim,
    /^\s*lyrics provided by.*$/gim,
    /^\s*lyrics powered by.*$/gim,
    /^\s*\(?c\)?\s*\d{4}.*$/gim,
    /^\s*www\..*$/gim,
    /^\s*https?:\/\/.*$/gim,
    /^\s*advertisement\s*$/gim,
    /^\s*sponsored\s*$/gim,
  ];

  for (const pattern of adPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Trim each line
  cleaned = cleaned
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

  // Collapse multiple blank lines to a single blank line
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

// ─── Lyrics Validation ──────────────────────────────────────────────────────

/**
 * Validates that fetched lyrics match the requested song by checking if
 * the lyrics response metadata contains the expected artist/title.
 *
 * Uses fuzzy matching: lowercased substring containment.
 *
 * @param queryArtist - The artist name that was searched for
 * @param queryTitle - The song title that was searched for
 * @param responseArtist - The artist name returned by the API
 * @param responseTitle - The title returned by the API
 * @returns true if the lyrics appear to match the query
 */
export function validateLyricsMatch(
  queryArtist: string,
  queryTitle: string,
  responseArtist: string | undefined | null,
  responseTitle: string | undefined | null,
): boolean {
  if (!responseArtist && !responseTitle) {
    // No metadata to validate against; accept the result optimistically
    return true;
  }

  const qArtist = queryArtist.toLowerCase().trim();
  const qTitle = queryTitle.toLowerCase().trim();
  const rArtist = (responseArtist || '').toLowerCase().trim();
  const rTitle = (responseTitle || '').toLowerCase().trim();

  // Check if either artist or title matches (fuzzy: substring containment)
  const artistMatch =
    rArtist.includes(qArtist) || qArtist.includes(rArtist) || rArtist.length === 0;
  const titleMatch = rTitle.includes(qTitle) || qTitle.includes(rTitle) || rTitle.length === 0;

  // Both should match, but if one is empty we accept the other
  return artistMatch && titleMatch;
}

// ─── LRCLIB API ─────────────────────────────────────────────────────────────

/**
 * Queries the LRCLIB API for lyrics by artist and title.
 *
 * LRCLIB provides a free API with no authentication required.
 * Uses the /api/get endpoint with track_name and artist_name params.
 *
 * @param artist - Artist name to search for
 * @param title - Song title to search for
 * @param options - Lyrics fetcher options
 * @returns LRCLIB API result or null if not found
 */
export async function queryLRCLIB(
  artist: string,
  title: string,
  options: LyricsFetcherOptions = {},
): Promise<LRCLIBResult | null> {
  const baseUrl = options.lrclibBaseUrl || LRCLIB_API_URL;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseRetryDelay ?? DEFAULT_BASE_RETRY_DELAY;
  const timeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await axios.get<LRCLIBResult>(`${baseUrl}/get`, {
        params: {
          track_name: title,
          artist_name: artist,
        },
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        timeout,
      });

      // LRCLIB returns 200 with data on success
      if (response.data) {
        return response.data;
      }

      return null;
    } catch (error: unknown) {
      if (isAxiosLikeError(error)) {
        const status = error.response?.status;

        // 404 = not found, don't retry
        if (status === 404) {
          return null;
        }

        // 4xx client errors (except 429) = don't retry
        if (status && status >= 400 && status < 500 && status !== 429) {
          return null;
        }

        // 5xx, 429, network errors are retryable
        lastError = new Error(`LRCLIB API request failed: ${error.message}`);
      } else if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }

      // If last attempt, don't throw - return null (lyrics are optional)
      if (attempt === maxRetries) {
        return null;
      }
    }
  }

  // Should never reach here, but for safety
  if (lastError) {
    return null;
  }
  return null;
}

/**
 * Queries LRCLIB using the /api/search endpoint as a fallback
 * when the exact /api/get match fails. Returns the best matching result.
 *
 * @param artist - Artist name to search for
 * @param title - Song title to search for
 * @param options - Lyrics fetcher options
 * @returns LRCLIB API result or null if not found
 */
export async function searchLRCLIB(
  artist: string,
  title: string,
  options: LyricsFetcherOptions = {},
): Promise<LRCLIBResult | null> {
  const baseUrl = options.lrclibBaseUrl || LRCLIB_API_URL;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseRetryDelay ?? DEFAULT_BASE_RETRY_DELAY;
  const timeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await axios.get<LRCLIBResult[]>(`${baseUrl}/search`, {
        params: {
          track_name: title,
          artist_name: artist,
        },
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        timeout,
      });

      // Find the best match from the search results
      if (response.data && Array.isArray(response.data)) {
        // Prefer non-instrumental results with plainLyrics
        const withLyrics = response.data.filter(
          (r) => !r.instrumental && r.plainLyrics && r.plainLyrics.length > 0,
        );

        if (withLyrics.length > 0) {
          // Find the best match by validating artist/title
          const validated = withLyrics.find((r) =>
            validateLyricsMatch(artist, title, r.artistName, r.trackName),
          );
          return validated || withLyrics[0];
        }
      }

      return null;
    } catch (error: unknown) {
      if (isAxiosLikeError(error)) {
        const status = error.response?.status;

        if (status === 404) return null;
        if (status && status >= 400 && status < 500 && status !== 429) return null;

        lastError = new Error(`LRCLIB search failed: ${error.message}`);
      } else if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }

      if (attempt === maxRetries) return null;
    }
  }

  if (lastError) return null;
  return null;
}

// ─── ChartLyrics API ────────────────────────────────────────────────────────

/**
 * Queries the ChartLyrics API for lyrics by artist and title.
 *
 * ChartLyrics is a free API with REST/JSON endpoints.
 * Two-step process:
 * 1. SearchLyric to find matching songs
 * 2. GetLyric to retrieve the actual lyrics text
 *
 * @param artist - Artist name to search for
 * @param title - Song title to search for
 * @param options - Lyrics fetcher options
 * @returns Lyrics text or null if not found
 */
export async function queryChartLyrics(
  artist: string,
  title: string,
  options: LyricsFetcherOptions = {},
): Promise<{ lyrics: string; artist: string; title: string } | null> {
  const baseUrl = options.chartLyricsBaseUrl || CHARTLYRICS_API_URL;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseRetryDelay ?? DEFAULT_BASE_RETRY_DELAY;
  const timeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;

  // Step 1: Search for the lyrics
  let searchResult: ChartLyricsResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await axios.get<ChartLyricsResult[]>(`${baseUrl}/SearchLyricDirect`, {
        params: {
          artist,
          song: title,
        },
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        timeout,
      });

      if (response.data) {
        // If the response is an array, find the best match
        if (Array.isArray(response.data)) {
          const matches = response.data.filter((r) => r.Lyric && r.Lyric.length > 0);
          if (matches.length > 0) {
            searchResult = matches[0];
          }
        } else {
          // If response is a single object
          const single = response.data as unknown as ChartLyricsResult;
          if (single.Lyric && single.Lyric.length > 0) {
            searchResult = single;
          }
        }
      }
      break; // Success (even if no results), stop retrying
    } catch (error: unknown) {
      if (isAxiosLikeError(error)) {
        const status = error.response?.status;
        if (status && status >= 400 && status < 500 && status !== 429) return null;
      } else if (!(error instanceof Error)) {
        // Unknown error type
      }

      if (attempt === maxRetries) return null;
    }
  }

  if (!searchResult || !searchResult.Lyric) {
    return null;
  }

  return {
    lyrics: searchResult.Lyric,
    artist: searchResult.LyricArtist || '',
    title: searchResult.LyricSong || '',
  };
}

// ─── Main Service ────────────────────────────────────────────────────────────

/**
 * Fetches lyrics for a song using artist and title.
 *
 * This is the main entry point for lyrics fetching. It:
 * 1. Checks the cache for existing results
 * 2. Queries LRCLIB /api/get (exact match)
 * 3. Falls back to LRCLIB /api/search (fuzzy match)
 * 4. Falls back to ChartLyrics API
 * 5. Validates lyrics match the query
 * 6. Cleans up lyrics formatting
 * 7. Caches and returns the result
 *
 * @param artist - Artist name to search for
 * @param title - Song title to search for
 * @param options - Lyrics fetcher configuration options
 * @param cache - Optional LyricsCache instance for caching
 * @returns LyricsResult with cleaned lyrics, or null if no lyrics found
 */
export async function fetchLyrics(
  artist: string,
  title: string,
  options: LyricsFetcherOptions = {},
  cache?: ILyricsCache,
): Promise<LyricsResult | null> {
  // Validate inputs
  if (!artist || !title || artist.trim().length === 0 || title.trim().length === 0) {
    return null;
  }

  const trimmedArtist = artist.trim();
  const trimmedTitle = title.trim();

  // Check cache first
  if (cache?.has(trimmedArtist, trimmedTitle)) {
    const cached = cache.get(trimmedArtist, trimmedTitle);
    // cached can be null (meaning "no lyrics found" was cached) or LyricsResult
    return cached === undefined ? null : cached;
  }

  // Step 1: Try LRCLIB exact match
  const lrclibExact = await queryLRCLIB(trimmedArtist, trimmedTitle, options);
  if (lrclibExact && !lrclibExact.instrumental && lrclibExact.plainLyrics) {
    const cleaned = cleanLyrics(lrclibExact.plainLyrics);
    if (cleaned.length > 0) {
      const validated = validateLyricsMatch(
        trimmedArtist,
        trimmedTitle,
        lrclibExact.artistName,
        lrclibExact.trackName,
      );
      const result: LyricsResult = {
        lyrics: cleaned,
        source: 'lrclib',
        validated,
      };
      if (cache) cache.set(trimmedArtist, trimmedTitle, result);
      return result;
    }
  }

  // Step 2: Try LRCLIB search (fuzzy match)
  const lrclibSearch = await searchLRCLIB(trimmedArtist, trimmedTitle, options);
  if (lrclibSearch && !lrclibSearch.instrumental && lrclibSearch.plainLyrics) {
    const cleaned = cleanLyrics(lrclibSearch.plainLyrics);
    if (cleaned.length > 0) {
      const validated = validateLyricsMatch(
        trimmedArtist,
        trimmedTitle,
        lrclibSearch.artistName,
        lrclibSearch.trackName,
      );
      const result: LyricsResult = {
        lyrics: cleaned,
        source: 'lrclib',
        validated,
      };
      if (cache) cache.set(trimmedArtist, trimmedTitle, result);
      return result;
    }
  }

  // Step 3: Try ChartLyrics fallback (unless skipped)
  if (!options.skipChartLyrics) {
    const chartResult = await queryChartLyrics(trimmedArtist, trimmedTitle, options);
    if (chartResult && chartResult.lyrics) {
      const cleaned = cleanLyrics(chartResult.lyrics);
      if (cleaned.length > 0) {
        const validated = validateLyricsMatch(
          trimmedArtist,
          trimmedTitle,
          chartResult.artist,
          chartResult.title,
        );
        const result: LyricsResult = {
          lyrics: cleaned,
          source: 'chartlyrics',
          validated,
        };
        if (cache) cache.set(trimmedArtist, trimmedTitle, result);
        return result;
      }
    }
  }

  // Step 4: Try Genius (when an access token is configured and step not skipped)
  const geniusToken = options.geniusAccessToken;
  if (!options.skipGenius && geniusToken) {
    try {
      const geniusResult = await queryGeniusLyrics(
        trimmedArtist,
        trimmedTitle,
        geniusToken,
        options.geniusRateLimiter,
        options.geniusBaseUrl,
        options.requestTimeout,
      );
      if (geniusResult) {
        const cleaned = cleanLyrics(geniusResult.lyrics);
        if (cleaned.length > 0) {
          const validated = validateLyricsMatch(
            trimmedArtist,
            trimmedTitle,
            geniusResult.artist,
            geniusResult.title,
          );
          const result: LyricsResult = {
            lyrics: cleaned,
            source: 'genius',
            validated,
          };
          if (cache) cache.set(trimmedArtist, trimmedTitle, result);
          return result;
        }
      }
    } catch {
      // Genius errors are non-fatal; fall through to "no lyrics found"
    }
  }

  // No lyrics found - cache the null result to avoid redundant API calls
  if (cache) cache.set(trimmedArtist, trimmedTitle, null);
  return null;
}

/**
 * Fetches lyrics for multiple songs in batch.
 *
 * Processes songs sequentially to be respectful of API servers.
 * Failures for individual songs are captured per-song without stopping the batch.
 *
 * @param songs - Array of { artist, title } objects
 * @param options - Lyrics fetcher configuration options
 * @param cache - Optional shared LyricsCache instance
 * @returns Array of results, each containing the song info and either lyrics or null
 */
export async function fetchMultipleLyrics(
  songs: Array<{ artist: string; title: string }>,
  options: LyricsFetcherOptions = {},
  cache?: LyricsCache,
): Promise<
  Array<{
    artist: string;
    title: string;
    result: LyricsResult | null;
    error: string | null;
  }>
> {
  const sharedCache = cache || new LyricsCache();
  const output: Array<{
    artist: string;
    title: string;
    result: LyricsResult | null;
    error: string | null;
  }> = [];

  for (const song of songs) {
    try {
      const result = await fetchLyrics(song.artist, song.title, options, sharedCache);
      output.push({
        artist: song.artist,
        title: song.title,
        result,
        error: null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.push({
        artist: song.artist,
        title: song.title,
        result: null,
        error: message,
      });
    }
  }

  return output;
}
