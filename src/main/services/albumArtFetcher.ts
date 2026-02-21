/**
 * Album Art Fetcher Service
 *
 * Multi-source album art pipeline fetching front cover art from:
 *   1. Cover Art Archive (CAA) — direct by MusicBrainz release ID
 *   2. Deezer Search API        — free, no auth required
 *   3. AudioDB API              — free tier, API key "2" embedded in URL
 *   4. Cover Art Archive (CAA) — two-step: search MusicBrainz for release ID first
 *   5. Generic URL              — iTunes / Spotify CDN artwork URLs
 *
 * All fetchers return null on any failure so album art is always best-effort.
 */

import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Image data returned from an album art source */
export interface AlbumArtResult {
  /** Raw image bytes */
  data: Buffer;
  /** MIME type reported by the server, e.g. "image/jpeg" or "image/png" */
  mimeType: string;
}

/** Minimal rate-limiter interface accepted by art fetchers */
interface WaitableRateLimiter {
  waitForSlot(): Promise<void>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CAA_BASE_URL = 'https://coverartarchive.org';
const MUSICBRAINZ_API_URL = 'https://musicbrainz.org/ws/2';
const DEEZER_API_URL = 'https://api.deezer.com';
const AUDIODB_API_URL = 'https://www.theaudiodb.com/api/v1/json/2';
const REQUEST_TIMEOUT_MS = 15_000; // 15 seconds

const DEEZER_RATE_LIMIT_INTERVAL = 300;   // ~3 req/sec (conservative)
const AUDIODB_RATE_LIMIT_INTERVAL = 500;  // ~2 req/sec (conservative)
const ART_RETRY_DELAY_MS = 2_000;         // delay before single retry on transient failure

// ─── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * Generic FIFO drain-queue rate limiter.
 *
 * A single class replaces the previously duplicated DeezerRateLimiter and
 * AudioDBRateLimiter — instantiate with the desired interval in milliseconds.
 * Exported as both `FifoRateLimiter` (canonical name) and the legacy aliases
 * so existing usages continue to work.
 */
export class FifoRateLimiter implements WaitableRateLimiter {
  private lastRequestTime = 0;
  private readonly intervalMs: number;
  private readonly waitQueue: Array<() => void> = [];
  private isDraining = false;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      if (!this.isDraining) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.isDraining = true;
    while (this.waitQueue.length > 0) {
      const now = Date.now();
      const remaining = this.intervalMs - (now - this.lastRequestTime);
      if (remaining > 0) await new Promise<void>((r) => setTimeout(r, remaining));
      this.lastRequestTime = Date.now();
      const next = this.waitQueue.shift();
      if (next) next();
    }
    this.isDraining = false;
  }
}

/** @deprecated Use FifoRateLimiter(DEEZER_RATE_LIMIT_INTERVAL) */
export class DeezerRateLimiter extends FifoRateLimiter {
  constructor(intervalMs: number = DEEZER_RATE_LIMIT_INTERVAL) { super(intervalMs); }
}

/** @deprecated Use FifoRateLimiter(AUDIODB_RATE_LIMIT_INTERVAL) */
export class AudioDBRateLimiter extends FifoRateLimiter {
  constructor(intervalMs: number = AUDIODB_RATE_LIMIT_INTERVAL) { super(intervalMs); }
}

// ─── Retry Helper ────────────────────────────────────────────────────────────

/**
 * Runs `fn` and, on any thrown error or null result, waits `delayMs` then
 * retries exactly once. Album art is best-effort so we never throw.
 */
async function withArtRetry<T>(
  fn: () => Promise<T | null>,
  delayMs: number = ART_RETRY_DELAY_MS,
): Promise<T | null> {
  const first = await fn().catch(() => null);
  if (first !== null) return first;
  await new Promise<void>((r) => setTimeout(r, delayMs));
  return fn().catch(() => null);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** URL-encode a query component (spaces as +, special chars percent-encoded) */
function encodeQuery(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

// ─── Image Dimension Parser ───────────────────────────────────────────────────

/**
 * Extracts image dimensions and bit-depth from raw JPEG or PNG bytes.
 * Used when embedding art in FLAC METADATA_BLOCK_PICTURE, which requires
 * width, height and colour-depth fields.
 *
 * Returns { width: 0, height: 0, depth: 0 } if parsing fails — players
 * will still display the art because the image bytes are present.
 */
export function getImageDimensions(
  data: Buffer,
  mimeType: string,
): { width: number; height: number; depth: number } {
  try {
    if (mimeType === 'image/png') {
      // PNG IHDR starts at byte 16 (after 8-byte sig + 4-byte length + 4-byte type)
      if (data.length >= 26) {
        const width = data.readUInt32BE(16);
        const height = data.readUInt32BE(20);
        const bitDepth = data[24];
        const colorType = data[25];
        // channels: 0=greyscale(1), 2=RGB(3), 3=indexed(1), 4=greyscale+alpha(2), 6=RGBA(4)
        const channels = [1, 0, 3, 1, 2, 0, 4][colorType] ?? 3;
        return { width, height, depth: bitDepth * channels };
      }
    } else {
      // JPEG: scan for SOF0/SOF1/SOF2 marker (FF C0..C3)
      let i = 2; // skip SOI marker (FF D8)
      while (i < data.length - 11) {
        if (data[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = data[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          // SOF: [FF][marker][segLen(2)][precision(1)][height(2)][width(2)][components(1)]
          const height = data.readUInt16BE(i + 5);
          const width = data.readUInt16BE(i + 7);
          const components = data[i + 9];
          return { width, height, depth: 8 * components };
        }
        if (marker === 0xda) break; // Start of Scan — no more SOF after this
        const segLen = data.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
  } catch {
    // Fall through to default
  }
  return { width: 0, height: 0, depth: 0 };
}

// ─── Main Fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetches the front cover art for a MusicBrainz release.
 *
 * Requests the `/front` redirect endpoint which returns the highest-quality
 * front cover image directly. Returns null if:
 * - The release has no cover art in the CAA (404)
 * - The network request fails after the timeout
 * - Any other error occurs (art is optional — we never fail a file for it)
 *
 * @param releaseId - MusicBrainz Release ID
 * @returns AlbumArtResult with image bytes and MIME type, or null
 */
export async function fetchAlbumArt(releaseId: string): Promise<AlbumArtResult | null> {
  if (!releaseId) return null;

  return withArtRetry(async () => {
    const response = await axios.get<ArrayBuffer>(
      `${CAA_BASE_URL}/release/${releaseId}/front`,
      {
        responseType: 'arraybuffer',
        timeout: REQUEST_TIMEOUT_MS,
        // Axios follows redirects by default (CAA uses 307 → actual image URL)
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      },
    );

    const contentType = (response.headers as Record<string, string>)['content-type'] ?? '';
    const mimeType = contentType.split(';')[0].trim() || 'image/jpeg';

    return {
      data: Buffer.from(response.data),
      mimeType,
    };
  });
}

/**
 * Fetches album art from an arbitrary image URL.
 *
 * Used when metadata came from iTunes (which provides a CDN artwork URL)
 * rather than MusicBrainz (which uses the Cover Art Archive by release ID).
 * Returns null on any network or parse error — art is always best-effort.
 *
 * @param url - Direct URL to the image (e.g. iTunes CDN 600×600 artwork URL)
 */
export async function fetchAlbumArtFromUrl(url: string): Promise<AlbumArtResult | null> {
  if (!url) return null;

  return withArtRetry(async () => {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    });

    const contentType = (response.headers as Record<string, string>)['content-type'] ?? '';
    const mimeType = contentType.split(';')[0].trim() || 'image/jpeg';

    return { data: Buffer.from(response.data), mimeType };
  });
}

// ─── Deezer ───────────────────────────────────────────────────────────────────

/** Shape of a single album entry returned by `GET /search/album` */
interface DeezerAlbum {
  id: number;
  title: string;
  cover_xl?: string;   // 1000×1000
  cover_big?: string;  //  500×500
  cover?: string;      //  120×120
}

/** Shape of the Deezer album search response */
interface DeezerAlbumSearchResponse {
  data?: DeezerAlbum[];
  error?: { message: string; type: string; code: number };
}

/** Shape of an album object embedded in a Deezer track search result */
interface DeezerTrackAlbum {
  cover_xl?: string;
  cover_big?: string;
  cover?: string;
}

/** Shape of the artist object embedded in a Deezer track search result */
interface DeezerTrackArtist {
  name?: string;
}

/** Shape of a single track entry returned by `GET /search` */
interface DeezerTrack {
  album?: DeezerTrackAlbum;
  artist?: DeezerTrackArtist;
}

/** Shape of the Deezer track search response */
interface DeezerTrackSearchResponse {
  data?: DeezerTrack[];
}

/**
 * Normalises an artist name for fuzzy comparison:
 * lowercase, strip non-alphanumeric, collapse whitespace.
 */
function normalizeArtist(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Returns true when `actual` is a plausible match for `expected`.
 * Accepts substring matches in either direction to handle "feat." variants,
 * abbreviated names, etc.
 */
function artistMatches(expected: string, actual: string): boolean {
  const exp = normalizeArtist(expected);
  const act = normalizeArtist(actual);
  if (!exp || !act) return false;
  return act.includes(exp) || exp.includes(act);
}

/** Extract the best cover URL from a Deezer album object */
function bestDeezerCover(album: DeezerAlbum | DeezerTrackAlbum): string | null {
  return album.cover_xl ?? album.cover_big ?? album.cover ?? null;
}

/**
 * Fetches album art via the Deezer API.
 *
 * Strategy (stops at first hit):
 *  1. If `album` is provided — album search: `GET /search/album?q={artist} {album}`
 *  2. Track search fallback: `GET /search?q={artist} {title}` — works even for
 *     singles where no album name is known; each track result carries album art.
 *
 * No authentication required.
 *
 * @param artist      - Artist name
 * @param title       - Track title (used in track-search fallback)
 * @param album       - Album title (optional; enables album search as first try)
 * @param rateLimiter - Optional DeezerRateLimiter to throttle concurrent calls
 * @returns AlbumArtResult or null on failure / no result
 */
export async function fetchAlbumArtFromDeezer(
  artist: string,
  title: string,
  album?: string | null,
  rateLimiter?: WaitableRateLimiter,
): Promise<AlbumArtResult | null> {
  if (!artist || !title) return null;

  try {
    // ── Strategy 1: album search (only when album name is known) ──────────────
    if (album) {
      if (rateLimiter) await rateLimiter.waitForSlot();

      const q = encodeQuery(`${artist} ${album}`);
      const albumResponse = await axios.get<DeezerAlbumSearchResponse>(
        `${DEEZER_API_URL}/search/album?q=${q}`,
        { timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status < 500 },
      );

      const albumResults = albumResponse.data?.data;
      if (albumResults && albumResults.length > 0) {
        const artUrl = bestDeezerCover(albumResults[0]);
        if (artUrl) return fetchAlbumArtFromUrl(artUrl);
      }
    }

    // ── Strategy 2: track search fallback (artist + title) ───────────────────
    if (rateLimiter) await rateLimiter.waitForSlot();

    const q = encodeQuery(`${artist} ${title}`);
    const trackResponse = await axios.get<DeezerTrackSearchResponse>(
      `${DEEZER_API_URL}/search?q=${q}`,
      { timeout: REQUEST_TIMEOUT_MS, validateStatus: (status) => status < 500 },
    );

    const trackResults = trackResponse.data?.data;
    if (!trackResults || trackResults.length === 0) return null;

    // Verify the first result's artist matches the expected artist to avoid
    // pulling artwork from a cover version of the same song.
    const matched = trackResults.find((t) => {
      const trackArtist = t.artist?.name ?? '';
      return !trackArtist || artistMatches(artist, trackArtist);
    });
    if (!matched) return null;

    const trackAlbum = matched.album;
    if (!trackAlbum) return null;

    const artUrl = bestDeezerCover(trackAlbum);
    if (!artUrl) return null;

    return fetchAlbumArtFromUrl(artUrl);
  } catch {
    return null;
  }
}

// ─── AudioDB ─────────────────────────────────────────────────────────────────

/** Shape of a single album from TheAudioDB */
interface AudioDBAlbum {
  strAlbumThumb?: string;
  strAlbum?: string;
  strArtist?: string;
}

/** Shape of the AudioDB searchalbum response */
interface AudioDBSearchResponse {
  album?: AudioDBAlbum[] | null;
}

/**
 * Fetches album art via TheAudioDB album search API.
 *
 * Queries `/searchalbum.php?s={artist}&a={album}` using the free public
 * API key ("2" embedded in the URL). Downloads `strAlbumThumb` from the
 * first matching result.
 *
 * @param artist       - Artist name
 * @param album        - Album title
 * @param rateLimiter  - Optional AudioDBRateLimiter to throttle concurrent calls
 * @returns AlbumArtResult or null on failure / no result
 */
export async function fetchAlbumArtFromAudioDB(
  artist: string,
  album: string,
  rateLimiter?: WaitableRateLimiter,
): Promise<AlbumArtResult | null> {
  if (!artist || !album) return null;

  try {
    if (rateLimiter) await rateLimiter.waitForSlot();

    const s = encodeURIComponent(artist);
    const a = encodeURIComponent(album);
    const searchResponse = await axios.get<AudioDBSearchResponse>(
      `${AUDIODB_API_URL}/searchalbum.php?s=${s}&a=${a}`,
      {
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: (status) => status < 500,
      },
    );

    const albums = searchResponse.data?.album;
    if (!albums || albums.length === 0) return null;

    const thumbUrl = albums[0].strAlbumThumb;
    if (!thumbUrl) return null;

    return fetchAlbumArtFromUrl(thumbUrl);
  } catch {
    return null;
  }
}

// ─── CAA Two-Step ─────────────────────────────────────────────────────────────

/** Shape of a single release entry from the MusicBrainz release search */
interface MBReleaseSearchEntry {
  id: string;
  title?: string;
  /** Match quality 0–100 as returned by MusicBrainz Lucene search */
  score?: number;
  status?: string;  // e.g. "Official", "Promotion", "Bootleg"
  'release-group'?: {
    'primary-type'?: string;  // e.g. "Album", "Single", "EP"
  };
}

/** Shape of the MusicBrainz release search response */
interface MBReleaseSearchResponse {
  releases?: MBReleaseSearchEntry[];
  count?: number;
  offset?: number;
}

/** Minimum MusicBrainz search score accepted for CAA two-step art lookup */
const CAA_MIN_SCORE = 80;

/**
 * Searches MusicBrainz for a release ID by artist and album name.
 *
 * This is the first step of the two-step Cover Art Archive flow used when no
 * MusicBrainz release ID is already known (e.g. metadata came from iTunes or
 * Spotify). The returned ID can be passed directly to `fetchAlbumArt()`.
 *
 * Uses the MusicBrainz release search endpoint with Lucene query syntax:
 *   `artist:{artist} AND release:{album}`
 *
 * @param artist      - Artist name
 * @param album       - Album title
 * @param rateLimiter - Optional rate limiter with `waitForSlot()` (should be
 *                      the shared MusicBrainzRateLimiter: 1 req/sec)
 * @returns MusicBrainz Release ID string, or null if not found
 */
export async function searchCAAByNames(
  artist: string,
  album: string,
  rateLimiter?: WaitableRateLimiter,
): Promise<string | null> {
  if (!artist || !album) return null;

  try {
    if (rateLimiter) await rateLimiter.waitForSlot();

    // Request more candidates so we can filter by score and release type.
    const query = encodeURIComponent(`artist:"${artist}" AND release:"${album}"`);
    const response = await axios.get<MBReleaseSearchResponse>(
      `${MUSICBRAINZ_API_URL}/release?query=${query}&limit=5&fmt=json`,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'User-Agent': 'AudioPipeline/1.0.0 (https://github.com/audio-pipeline)',
          Accept: 'application/json',
        },
        validateStatus: (status) => status < 500,
      },
    );

    const releases = response.data?.releases;
    if (!releases || releases.length === 0) return null;

    // Prefer official Album releases with a high match score.
    // Fall back through progressively relaxed criteria so we always return
    // the best available ID rather than nothing.
    const scored = releases.filter((r) => (r.score ?? 0) >= CAA_MIN_SCORE);

    const officialAlbum = scored.find(
      (r) =>
        r.status?.toLowerCase() === 'official' &&
        r['release-group']?.['primary-type']?.toLowerCase() === 'album',
    );
    if (officialAlbum) return officialAlbum.id;

    const officialAny = scored.find((r) => r.status?.toLowerCase() === 'official');
    if (officialAny) return officialAny.id;

    // Accept any high-scoring result if nothing Official is found.
    if (scored.length > 0) return scored[0].id;

    return null;
  } catch {
    return null;
  }
}
