/**
 * Spotify Web API Client for Audio Pipeline
 *
 * Uses the Client Credentials flow (no user login required) to:
 *  - Search for tracks by artist + title
 *  - Retrieve album art from Spotify CDN
 *
 * Rate limiting:
 *  - Enforces ~3 requests/second (one request per 334 ms) via a FIFO drain queue
 *  - Respects the `Retry-After` response header on HTTP 429 responses
 *
 * Token management:
 *  - Fetches an access token automatically on first use
 *  - Refreshes the token before it expires (token lifetime is 3600 s)
 */

import { MusicBrainzMetadata } from '../../shared/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
const REQUEST_TIMEOUT_MS = 10_000;
/** Refresh the token this many milliseconds before it would actually expire */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result returned by searchSpotify */
export interface SpotifyResult {
  /** Metadata mapped to the shared MusicBrainzMetadata shape */
  metadata: MusicBrainzMetadata;
  /** High-resolution artwork URL from Spotify CDN (may be undefined) */
  artworkUrl: string | undefined;
}

/** Search terms accepted by searchSpotify */
export interface SpotifySearchTerms {
  title: string;
  artist?: string;
}

// Raw shapes we parse from the Spotify REST responses ─────────────────────────

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SpotifyArtistObject {
  name: string;
}

interface SpotifyImageObject {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyAlbumObject {
  id: string;
  name: string;
  images: SpotifyImageObject[];
  release_date: string; // e.g. "2023-07-14" or "2023" or "2023-07"
}

interface SpotifyTrackObject {
  id: string;
  name: string;
  artists: SpotifyArtistObject[];
  album: SpotifyAlbumObject;
}

interface SpotifySearchResponse {
  tracks: {
    items: SpotifyTrackObject[];
  };
}

// ─── Token Manager ─────────────────────────────────────────────────────────

/**
 * Manages a Spotify Client Credentials access token.
 * Automatically fetches and refreshes the token as needed.
 */
export class SpotifyTokenManager {
  private token: string | null = null;
  private expiresAt: number = 0;
  private fetchingPromise: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  /**
   * Returns a valid access token, fetching or refreshing it as necessary.
   */
  async getToken(): Promise<string> {
    // Return cached token if still valid
    if (this.token && Date.now() < this.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.token;
    }

    // Coalesce simultaneous requests into one token fetch
    if (this.fetchingPromise) {
      return this.fetchingPromise;
    }

    this.fetchingPromise = this.fetchToken().finally(() => {
      this.fetchingPromise = null;
    });

    return this.fetchingPromise;
  }

  private async fetchToken(): Promise<string> {
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`Spotify token request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SpotifyTokenResponse;
    this.token = data.access_token;
    // expires_in is in seconds; store as absolute epoch ms
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.token;
  }

  /** Invalidate the cached token (call when a 401 response is received). */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * FIFO drain-queue rate limiter for Spotify API calls.
 *
 * Drains one request every `intervalMs` milliseconds. When a 429 response is
 * received, call `handleRetryAfter(seconds)` to pause the drain queue for the
 * required amount of time before resuming.
 */
export class SpotifyRateLimiter {
  private readonly intervalMs: number;
  private nextSlotAt: number = 0;
  private waitQueue: Array<() => void> = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAfterUntil: number = 0;

  constructor(intervalMs: number = 334) {
    this.intervalMs = intervalMs;
  }

  /**
   * Waits until a request slot is available, then resolves.
   */
  waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      this.scheduleDrain();
    });
  }

  /**
   * Pause the drain queue for `seconds` seconds (called after receiving a
   * Retry-After header with a 429 response).
   */
  handleRetryAfter(seconds: number): void {
    const resumeAt = Date.now() + seconds * 1000;
    if (resumeAt > this.retryAfterUntil) {
      this.retryAfterUntil = resumeAt;
    }
    // Clear any pending drain timer and reschedule
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null || this.waitQueue.length === 0) return;

    const now = Date.now();
    // Honour both the steady-state interval and any Retry-After delay
    const nextAllowedAt = Math.max(this.nextSlotAt, this.retryAfterUntil);
    const delay = Math.max(0, nextAllowedAt - now);

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.waitQueue.length > 0) {
        const resolve = this.waitQueue.shift()!;
        this.nextSlotAt = Date.now() + this.intervalMs;
        resolve();
      }
      if (this.waitQueue.length > 0) {
        this.scheduleDrain();
      }
    }, delay);
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Parses a Spotify release_date string ("2023-07-14", "2023-07", "2023") into
 * a 4-digit year, or null if it cannot be parsed.
 */
function parseReleaseYear(releaseDate: string): number | null {
  const year = parseInt(releaseDate.slice(0, 4), 10);
  return isNaN(year) ? null : year;
}

/**
 * Picks the largest image from a Spotify image array, falling back to the
 * first element when dimensions are unknown.
 */
function pickBestImage(images: SpotifyImageObject[]): string | undefined {
  if (images.length === 0) return undefined;

  let best = images[0];
  let bestArea = (best.width ?? 0) * (best.height ?? 0);
  for (const img of images) {
    const area = (img.width ?? 0) * (img.height ?? 0);
    if (area > bestArea) {
      best = img;
      bestArea = area;
    }
  }
  return best.url;
}

/**
 * Maps a raw Spotify track object to the shared MusicBrainzMetadata shape.
 */
function mapTrackToMetadata(track: SpotifyTrackObject): MusicBrainzMetadata {
  const [primaryArtist, ...featuredArtists] = track.artists.map((a) => a.name);

  return {
    recordingId: track.id,
    releaseId: null, // Spotify album IDs are not MusicBrainz release IDs
    title: track.name,
    artist: primaryArtist ?? 'Unknown Artist',
    featuredArtists,
    album: track.album.name || null,
    year: parseReleaseYear(track.album.release_date),
    genres: [], // Genre is not available on track objects in the Spotify Search API
  };
}

// ─── Main Search Function ─────────────────────────────────────────────────────

/**
 * Searches for a track on Spotify and returns metadata + artwork URL.
 *
 * @param terms    - Search terms (title required, artist optional)
 * @param clientId     - Spotify application Client ID
 * @param clientSecret - Spotify application Client Secret
 * @param rateLimiter  - Optional shared rate limiter (one per BatchProcessor)
 * @param tokenManager - Optional shared token manager (one per BatchProcessor)
 * @param timeoutMs    - HTTP request timeout in milliseconds
 * @returns The best matching SpotifyResult, or null if no match found
 */
export async function searchSpotify(
  terms: SpotifySearchTerms,
  clientId: string,
  clientSecret: string,
  rateLimiter?: SpotifyRateLimiter,
  tokenManager?: SpotifyTokenManager,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<SpotifyResult | null> {
  if (!clientId || !clientSecret) return null;
  if (!terms.title) return null;

  // Use a fallback (non-shared) token manager if none is provided
  const tm = tokenManager ?? new SpotifyTokenManager(clientId, clientSecret, timeoutMs);

  // Build the query string
  const queryParts = [`track:${terms.title}`];
  if (terms.artist) queryParts.push(`artist:${terms.artist}`);
  const q = queryParts.join(' ');

  // Wait for a rate-limit slot
  if (rateLimiter) await rateLimiter.waitForSlot();

  const token = await tm.getToken();

  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', '5');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  // Handle rate limiting
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 30;
    if (rateLimiter) {
      rateLimiter.handleRetryAfter(isNaN(retryAfterSeconds) ? 30 : retryAfterSeconds);
    }
    throw new Error(
      `Spotify rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    );
  }

  // Handle expired / revoked token
  if (response.status === 401) {
    tm.invalidate();
    throw new Error('Spotify access token is invalid or expired. Will retry on next call.');
  }

  if (!response.ok) {
    throw new Error(`Spotify search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as SpotifySearchResponse;
  const items = data?.tracks?.items;

  if (!items || items.length === 0) return null;

  const track = items[0];
  const metadata = mapTrackToMetadata(track);
  const artworkUrl = pickBestImage(track.album.images);

  return { metadata, artworkUrl };
}
