/**
 * Genius Lyrics Client for Audio Pipeline
 *
 * Two-step process per song:
 *  1. Search the Genius API to find the lyrics page URL for the best matching track.
 *  2. Fetch and scrape that page to extract the plain lyrics text.
 *
 * Authentication: Bearer token (Client Access Token from genius.com/api-clients).
 * No user login required — the Client Access Token is generated on the dashboard.
 *
 * Rate limiting:
 *  - 2000 ms between requests (~30 req / min) via a shared FIFO drain queue.
 *  - Handles HTTP 429 Retry-After headers.
 */

import axios from 'axios';

// ─── Constants ────────────────────────────────────────────────────────────────

const GENIUS_API_BASE = 'https://api.genius.com';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_USER_AGENT = 'AudioPipeline/1.0.0 (https://github.com/audio-pipeline)';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Result returned by queryGeniusLyrics */
export interface GeniusLyricsResult {
  /** Plain lyric text, cleaned */
  lyrics: string;
  /** Matched artist name as returned by Genius */
  artist: string;
  /** Matched song title as returned by Genius */
  title: string;
}

// Raw Genius API shapes ──────────────────────────────────────────────────────

interface GeniusArtistObject {
  name: string;
}

interface GeniusHitResult {
  id: number;
  title: string;
  title_with_featured: string;
  url: string;
  primary_artist: GeniusArtistObject;
}

interface GeniusHit {
  type: string;
  result: GeniusHitResult;
}

interface GeniusSearchResponse {
  meta: { status: number };
  response: { hits: GeniusHit[] };
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

/**
 * FIFO drain-queue rate limiter for Genius API calls.
 * Drains one request every `intervalMs` milliseconds.
 * Call `handleRetryAfter(seconds)` when a 429 is received.
 */
export class GeniusRateLimiter {
  private readonly intervalMs: number;
  private nextSlotAt: number = 0;
  private waitQueue: Array<() => void> = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAfterUntil: number = 0;

  constructor(intervalMs: number = 2000) {
    this.intervalMs = intervalMs;
  }

  waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      this.scheduleDrain();
    });
  }

  handleRetryAfter(seconds: number): void {
    const resumeAt = Date.now() + seconds * 1000;
    if (resumeAt > this.retryAfterUntil) this.retryAfterUntil = resumeAt;
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null || this.waitQueue.length === 0) return;
    const now = Date.now();
    const nextAllowedAt = Math.max(this.nextSlotAt, this.retryAfterUntil);
    const delay = Math.max(0, nextAllowedAt - now);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.waitQueue.length > 0) {
        const resolve = this.waitQueue.shift()!;
        this.nextSlotAt = Date.now() + this.intervalMs;
        resolve();
      }
      if (this.waitQueue.length > 0) this.scheduleDrain();
    }, delay);
  }
}

// ─── HTML Lyrics Scraper ──────────────────────────────────────────────────────

/**
 * Extracts lyric text from a Genius HTML page.
 *
 * Genius stores lyrics in one or more <div data-lyrics-container="true"> elements.
 * Each block may contain <br>, <a>, and other inline elements.
 * This parser:
 *  1. Collects every lyrics-container block.
 *  2. Replaces <br> with newlines.
 *  3. Strips all other HTML tags.
 *  4. Decodes common HTML entities.
 */
function extractLyricsFromHtml(html: string): string | null {
  const marker = 'data-lyrics-container="true"';
  const blocks: string[] = [];
  let searchFrom = 0;

  for (;;) {
    const markerIdx = html.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;

    // Advance to the closing > of the opening <div> tag
    const openTagEnd = html.indexOf('>', markerIdx);
    if (openTagEnd === -1) break;

    // Walk forward counting div depth to find the matching </div>
    let depth = 1;
    let i = openTagEnd + 1;
    while (i < html.length && depth > 0) {
      if (html[i] === '<') {
        // Check for opening or closing div
        if (html.slice(i, i + 4) === '<div') {
          depth++;
        } else if (html.slice(i, i + 6) === '</div') {
          depth--;
        }
      }
      if (depth > 0) i++;
    }

    blocks.push(html.slice(openTagEnd + 1, i));
    searchFrom = i + 1;
  }

  if (blocks.length === 0) return null;

  const text = blocks
    .map((block) => {
      // Replace <br> variants with newlines
      let t = block.replace(/<br\s*\/?>/gi, '\n');
      // Strip remaining HTML tags
      t = t.replace(/<[^>]+>/g, '');
      // Decode common HTML entities
      t = t
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;|&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ');
      return t.trim();
    })
    .join('\n\n');

  return text.trim() || null;
}

// ─── Axios Error Helper ───────────────────────────────────────────────────────

interface AxiosLikeError extends Error {
  isAxiosError: boolean;
  response?: { status: number; headers?: Record<string, string> };
}

function isAxiosLikeError(err: unknown): err is AxiosLikeError {
  return (
    err !== null &&
    typeof err === 'object' &&
    'isAxiosError' in err &&
    (err as { isAxiosError: unknown }).isAxiosError === true
  );
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Calls the Genius Search API and returns the best matching song URL,
 * artist, and title. Returns null if no suitable match is found.
 */
export async function searchGeniusSong(
  artist: string,
  title: string,
  accessToken: string,
  baseUrl: string = GENIUS_API_BASE,
  rateLimiter?: GeniusRateLimiter,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ url: string; artist: string; title: string } | null> {
  if (!accessToken) return null;

  if (rateLimiter) await rateLimiter.waitForSlot();

  const query = `${artist} ${title}`;

  try {
    const response = await axios.get<GeniusSearchResponse>(`${baseUrl}/search`, {
      params: { q: query },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'application/json',
      },
      timeout: timeoutMs,
    });

    const hits = response.data?.response?.hits ?? [];
    // Filter to song hits only
    const songHits = hits.filter((h) => h.type === 'song');
    if (songHits.length === 0) return null;

    // Pick the first hit (Genius ranks by relevance)
    const best = songHits[0].result;
    return {
      url: best.url,
      artist: best.primary_artist.name,
      title: best.title,
    };
  } catch (error: unknown) {
    if (isAxiosLikeError(error) && error.response?.status === 429) {
      const retryAfter = error.response.headers?.['retry-after'];
      const seconds = retryAfter ? parseInt(retryAfter, 10) : 30;
      if (rateLimiter) rateLimiter.handleRetryAfter(isNaN(seconds) ? 30 : seconds);
      throw new Error(`Genius rate limit hit. Retry after ${seconds}s.`);
    }
    if (isAxiosLikeError(error) && error.response?.status === 401) {
      throw new Error('Genius access token is invalid or expired.');
    }
    // Treat other errors as "not found" (lyrics are optional)
    return null;
  }
}

/**
 * Fetches a Genius lyrics page and returns the scraped lyrics text.
 */
export async function fetchGeniusPage(
  pageUrl: string,
  rateLimiter?: GeniusRateLimiter,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  if (rateLimiter) await rateLimiter.waitForSlot();

  try {
    const response = await axios.get<string>(pageUrl, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html',
      },
      timeout: timeoutMs,
      // axios returns a string when responseType is not set and content-type is text/html
      responseType: 'text',
    });

    return extractLyricsFromHtml(response.data);
  } catch {
    return null;
  }
}

// ─── Main Function ────────────────────────────────────────────────────────────

/**
 * Fetches lyrics for a song from Genius.
 *
 * 1. Calls the Genius Search API to find the best match.
 * 2. Fetches and scrapes the lyrics page.
 *
 * @param artist       - Artist name
 * @param title        - Song title
 * @param accessToken  - Genius Client Access Token
 * @param rateLimiter  - Optional shared rate limiter
 * @param baseUrl      - Override API base URL (for testing)
 * @param timeoutMs    - HTTP timeout
 * @returns Lyrics result or null if not found / error
 */
export async function queryGeniusLyrics(
  artist: string,
  title: string,
  accessToken: string,
  rateLimiter?: GeniusRateLimiter,
  baseUrl: string = GENIUS_API_BASE,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GeniusLyricsResult | null> {
  if (!accessToken || !artist || !title) return null;

  // Step 1: search for the song
  const songInfo = await searchGeniusSong(artist, title, accessToken, baseUrl, rateLimiter, timeoutMs);
  if (!songInfo) return null;

  // Step 2: scrape the lyrics page
  const lyrics = await fetchGeniusPage(songInfo.url, rateLimiter, timeoutMs);
  if (!lyrics) return null;

  return { lyrics, artist: songInfo.artist, title: songInfo.title };
}
