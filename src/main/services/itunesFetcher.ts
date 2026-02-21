/**
 * iTunes Search API Fallback Metadata Fetcher
 *
 * Used when AcoustID fingerprinting finds no match, or when MusicBrainz returns
 * no metadata for a fingerprinted recording. The iTunes Search API is free,
 * requires no authentication, and has broad coverage of mainstream music.
 *
 * Results are mapped to the same MusicBrainzMetadata shape so the rest of
 * the pipeline (lyrics, tag writing, renaming) works identically regardless
 * of which source provided the metadata.
 */

import * as path from 'path';
import axios from 'axios';
import { AudioFileMetadata, MusicBrainzMetadata } from '../../shared/types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Search terms extracted from embedded tags or filename */
export interface ItunesSearchTerms {
  title: string;
  artist?: string;
}

/** Combined result returned from a successful iTunes search */
export interface ItunesResult {
  /** Metadata mapped to the shared MusicBrainzMetadata shape */
  metadata: MusicBrainzMetadata;
  /**
   * High-resolution artwork URL from the iTunes CDN.
   * Pass this to fetchAlbumArtFromUrl() to embed the cover art.
   */
  artworkUrl?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * iTunes Search API rate limit.
 *
 * Apple does not publish an official rate limit. Community testing shows
 * throttling begins around 20 requests/minute (~3 sec/request). We use
 * 3 seconds between requests to stay well clear of that threshold.
 */
const ITUNES_RATE_LIMIT_INTERVAL = 3_000; // 3 seconds → ≤ 20 req/min

// ─── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * FIFO queue-based rate limiter for the iTunes Search API.
 *
 * Apple doesn't publish a formal limit but community testing shows throttling
 * around 20 requests/minute. This limiter enforces one request every 3 seconds
 * (~20 req/min) and serialises all concurrent callers so a batch of files never
 * bursts past the limit.
 */
export class ItunesRateLimiter {
  private lastRequestTime = 0;
  private readonly intervalMs: number;
  private readonly waitQueue: Array<() => void> = [];
  private isDraining = false;

  constructor(intervalMs: number = ITUNES_RATE_LIMIT_INTERVAL) {
    this.intervalMs = intervalMs;
  }

  /** Waits until the next iTunes request slot is available (FIFO). */
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Matches strings that look like a domain/download-site name (e.g. "spotifydown.com") */
const DOMAIN_PATTERN = /[\w.-]+\.(com|net|org|io|co|fm|me|to)\b/i;

/**
 * Strips download-site domain prefixes from a filename to extract the track title.
 *
 * Examples:
 *   "spotifydown.com - Feel My Love.mp3"  →  "Feel My Love"
 *   "mp3juice.cc - Kinni Kinni.mp3"       →  "Kinni Kinni"
 *   "Artist - Title.mp3"                  →  "Artist - Title"  (unchanged; no domain)
 */
export function titleFromFilename(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  // Only strip when the prefix before " - " looks like "something.tld"
  const cleaned = base.replace(/^[\w.-]+\.(com|net|org|io|co|fm|me|to)\s*[-–—]\s*/i, '').trim();
  return cleaned || base;
}

/**
 * Returns the best title (and optionally artist) to search iTunes with.
 *
 * Prefers embedded audio tags when they look legitimate. Falls back to
 * filename parsing when the tags contain download-site junk like "spotifydown.com".
 */
export function extractSearchTerms(
  audioMeta: AudioFileMetadata | null,
  filePath: string,
): ItunesSearchTerms {
  const embeddedTitle = audioMeta?.title?.trim() ?? null;
  const embeddedArtist = audioMeta?.artist?.trim() ?? null;

  const isJunk = (s: string | null): boolean =>
    !s || s.length < 2 || DOMAIN_PATTERN.test(s);

  const title = !isJunk(embeddedTitle) ? embeddedTitle! : titleFromFilename(filePath);
  const artist = !isJunk(embeddedArtist) ? embeddedArtist! : undefined;

  return { title, artist };
}

// ─── iTunesTrack (internal API shape) ────────────────────────────────────────

interface ItunesTrack {
  wrapperType: string;
  kind: string;
  artistName: string;
  collectionName?: string;
  trackName: string;
  primaryGenreName?: string;
  releaseDate?: string;
  artworkUrl100?: string;
}

// ─── Main Search Function ─────────────────────────────────────────────────────

/**
 * Searches the iTunes Search API for a track and returns the best match.
 *
 * Tries to find an exact title match among the top 5 results; falls back to
 * the first result if none match exactly. Returns null on network errors or
 * when the API returns no results.
 *
 * The returned metadata uses `releaseId: null` (no MusicBrainz release ID),
 * so album art must come from `artworkUrl` via fetchAlbumArtFromUrl().
 *
 * @param terms       - Title and optional artist to search
 * @param rateLimiter - Shared rate limiter (pass the BatchProcessor's instance for batches)
 * @param timeoutMs   - Request timeout in milliseconds (default: 10 s)
 */
export async function searchItunes(
  terms: ItunesSearchTerms,
  rateLimiter?: ItunesRateLimiter,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ItunesResult | null> {
  const { title, artist } = terms;
  // Combine artist + title for a more specific query when artist is known
  const query = artist ? `${artist} ${title}` : title;

  // Respect rate limit before making the network request
  if (rateLimiter) {
    await rateLimiter.waitForSlot();
  }

  try {
    const response = await axios.get<{ resultCount: number; results: ItunesTrack[] }>(
      ITUNES_SEARCH_URL,
      {
        params: { term: query, entity: 'song', media: 'music', limit: 5 },
        timeout: timeoutMs,
      },
    );

    const tracks = response.data.results.filter(
      (r) => r.wrapperType === 'track' && r.kind === 'song',
    );
    if (tracks.length === 0) return null;

    // Prefer an exact title match (case-insensitive), else take the first result
    const exactMatch = tracks.find((t) => t.trackName.toLowerCase() === title.toLowerCase());
    const track = exactMatch ?? tracks[0];

    // Parse year from iTunes ISO date string (e.g. "2011-01-01T08:00:00Z")
    const yearNum = track.releaseDate ? new Date(track.releaseDate).getFullYear() : null;
    const year = yearNum !== null && !isNaN(yearNum) ? yearNum : null;

    // Upscale artwork: iTunes serves 100×100 by default; 600×600 is usually available
    const artworkUrl = track.artworkUrl100
      ? track.artworkUrl100.replace('100x100bb', '600x600bb').replace('100x100', '600x600')
      : undefined;

    const metadata: MusicBrainzMetadata = {
      recordingId: `itunes-${Date.now()}`,
      releaseId: null,
      title: track.trackName,
      artist: track.artistName,
      featuredArtists: [],
      album: track.collectionName ?? null,
      year,
      genres: track.primaryGenreName ? [track.primaryGenreName] : [],
    };

    return { metadata, artworkUrl };
  } catch {
    // iTunes is a best-effort fallback; never propagate network/parse errors
    return null;
  }
}
