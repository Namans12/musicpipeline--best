/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  MBRecordingResponse,
  MetadataFetcherOptions,
  MetadataCache,
  MusicBrainzRateLimiter,
  parseArtistCredits,
  selectBestRelease,
  extractYear,
  extractGenres,
  queryMusicBrainz,
  mapResponseToMetadata,
  fetchRecordingMetadata,
  fetchBestMetadata,
  fetchMultipleRecordings,
} from '../../../src/main/services/metadataFetcher';
import type { MusicBrainzMetadata } from '../../../src/shared/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('axios', () => {
  const mockAxios = {
    get: vi.fn(),
    isAxiosError: vi.fn((err: unknown) => {
      return (
        err !== null &&
        typeof err === 'object' &&
        'isAxiosError' in err &&
        (err as { isAxiosError: boolean }).isAxiosError === true
      );
    }),
  };
  return { default: mockAxios };
});

/** Get the mocked axios.get function */
function getMockedAxiosGet(): ReturnType<typeof vi.mocked<typeof axios.get>> {
  return vi.mocked(axios.get);
}

/** Default test options */
const DEFAULT_OPTIONS: MetadataFetcherOptions = {
  apiBaseUrl: 'https://test-musicbrainz.org/ws/2',
  maxRetries: 2,
  baseRetryDelay: 10, // Very short for tests
  userAgent: 'TestAgent/1.0',
  minTagCount: 1,
};

/** Sample recording ID */
const SAMPLE_RECORDING_ID = '12345678-1234-1234-1234-123456789012';

/** Create a mock MusicBrainz recording response */
function createMockResponse(overrides: Partial<MBRecordingResponse> = {}): MBRecordingResponse {
  return {
    id: SAMPLE_RECORDING_ID,
    title: 'Bohemian Rhapsody',
    'artist-credit': [
      {
        name: 'Queen',
        artist: {
          id: 'artist-id-1',
          name: 'Queen',
          'sort-name': 'Queen',
        },
      },
    ],
    releases: [
      {
        id: 'release-id-1',
        title: 'A Night at the Opera',
        date: '1975-11-21',
        status: 'Official',
        'release-group': {
          id: 'rg-id-1',
          'primary-type': 'Album',
        },
      },
    ],
    tags: [
      { name: 'rock', count: 15 },
      { name: 'classic rock', count: 10 },
      { name: 'progressive rock', count: 5 },
    ],
    length: 354000,
    ...overrides,
  };
}

/** Mock a successful MusicBrainz API response */
function mockApiSuccess(response: MBRecordingResponse): void {
  getMockedAxiosGet().mockResolvedValueOnce({ data: response });
}

/** Mock an API error (axios-like) */
function mockApiAxiosError(status: number, message: string = 'Request failed'): void {
  const error = new Error(message) as Error & {
    isAxiosError: boolean;
    response?: { status: number; data?: unknown };
  };
  error.isAxiosError = true;
  error.response = { status };
  getMockedAxiosGet().mockRejectedValueOnce(error);
}

/** Mock a network error */
function mockApiNetworkError(message: string = 'Network Error'): void {
  const error = new Error(message) as Error & { isAxiosError: boolean };
  error.isAxiosError = true;
  getMockedAxiosGet().mockRejectedValueOnce(error);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MetadataCache', () => {
  let cache: MetadataCache;

  const sampleMetadata: MusicBrainzMetadata = {
    recordingId: SAMPLE_RECORDING_ID,
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    featuredArtists: [],
    album: 'A Night at the Opera',
    year: 1975,
    genres: ['Rock'],
  };

  beforeEach(() => {
    cache = new MetadataCache();
  });

  it('should store and retrieve metadata by recording ID', () => {
    cache.set(SAMPLE_RECORDING_ID, sampleMetadata);
    expect(cache.has(SAMPLE_RECORDING_ID)).toBe(true);
    expect(cache.get(SAMPLE_RECORDING_ID)).toEqual(sampleMetadata);
  });

  it('should return undefined for uncached recording IDs', () => {
    expect(cache.has('non-existent-id')).toBe(false);
    expect(cache.get('non-existent-id')).toBeUndefined();
  });

  it('should delete cached entries', () => {
    cache.set(SAMPLE_RECORDING_ID, sampleMetadata);
    expect(cache.delete(SAMPLE_RECORDING_ID)).toBe(true);
    expect(cache.has(SAMPLE_RECORDING_ID)).toBe(false);
  });

  it('should return false when deleting non-existent entry', () => {
    expect(cache.delete('non-existent-id')).toBe(false);
  });

  it('should clear all cached entries', () => {
    cache.set(SAMPLE_RECORDING_ID, sampleMetadata);
    cache.set('another-id', { ...sampleMetadata, recordingId: 'another-id' });
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('should report correct size', () => {
    expect(cache.size).toBe(0);
    cache.set(SAMPLE_RECORDING_ID, sampleMetadata);
    expect(cache.size).toBe(1);
  });

  it('should overwrite existing entries', () => {
    cache.set(SAMPLE_RECORDING_ID, sampleMetadata);
    const updated = { ...sampleMetadata, title: 'Updated Title' };
    cache.set(SAMPLE_RECORDING_ID, updated);
    expect(cache.get(SAMPLE_RECORDING_ID)?.title).toBe('Updated Title');
    expect(cache.size).toBe(1);
  });
});

describe('MusicBrainzRateLimiter', () => {
  it('should allow the first request immediately', async () => {
    const limiter = new MusicBrainzRateLimiter(1000);
    const start = Date.now();
    await limiter.waitForSlot();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // Should be near-instant
  });

  it('should enforce minimum interval between requests', async () => {
    const interval = 100;
    const limiter = new MusicBrainzRateLimiter(interval);

    await limiter.waitForSlot(); // First request, immediate
    const start = Date.now();
    await limiter.waitForSlot(); // Second request, should wait
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(interval - 20); // Allow small variance
  });

  it('should allow request after interval has elapsed', async () => {
    const interval = 50;
    const limiter = new MusicBrainzRateLimiter(interval);

    await limiter.waitForSlot();
    await new Promise<void>((resolve) => setTimeout(resolve, interval + 20));

    const start = Date.now();
    await limiter.waitForSlot();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('parseArtistCredits', () => {
  it('should return Unknown Artist for undefined credits', () => {
    const result = parseArtistCredits(undefined);
    expect(result.artist).toBe('Unknown Artist');
    expect(result.featuredArtists).toEqual([]);
  });

  it('should return Unknown Artist for empty credits array', () => {
    const result = parseArtistCredits([]);
    expect(result.artist).toBe('Unknown Artist');
    expect(result.featuredArtists).toEqual([]);
  });

  it('should handle single artist correctly', () => {
    const credits = [
      {
        name: 'Queen',
        artist: { id: '1', name: 'Queen' },
      },
    ];
    const result = parseArtistCredits(credits);
    expect(result.artist).toBe('Queen');
    expect(result.featuredArtists).toEqual([]);
  });

  it('should use credit name over artist name', () => {
    const credits = [
      {
        name: 'The Beatles',
        artist: { id: '1', name: 'Beatles, The' },
      },
    ];
    const result = parseArtistCredits(credits);
    expect(result.artist).toBe('The Beatles');
  });

  it('should fall back to artist.name when credit name is empty', () => {
    const credits = [
      {
        name: '',
        artist: { id: '1', name: 'Fallback Artist' },
      },
    ];
    const result = parseArtistCredits(credits);
    expect(result.artist).toBe('Fallback Artist');
  });

  it('should extract featured artists from multiple credits', () => {
    const credits = [
      {
        name: 'Jay-Z',
        joinphrase: ' feat. ',
        artist: { id: '1', name: 'Jay-Z' },
      },
      {
        name: 'Kanye West',
        artist: { id: '2', name: 'Kanye West' },
      },
    ];
    const result = parseArtistCredits(credits);
    expect(result.artist).toBe('Jay-Z');
    expect(result.featuredArtists).toEqual(['Kanye West']);
  });

  it('should handle multiple featured artists', () => {
    const credits = [
      {
        name: 'DJ Khaled',
        joinphrase: ' feat. ',
        artist: { id: '1', name: 'DJ Khaled' },
      },
      {
        name: 'Drake',
        joinphrase: ' & ',
        artist: { id: '2', name: 'Drake' },
      },
      {
        name: 'Lil Wayne',
        artist: { id: '3', name: 'Lil Wayne' },
      },
    ];
    const result = parseArtistCredits(credits);
    expect(result.artist).toBe('DJ Khaled');
    expect(result.featuredArtists).toEqual(['Drake', 'Lil Wayne']);
  });

  it('should treat all subsequent artists as featured', () => {
    const credits = [
      {
        name: 'Main Artist',
        artist: { id: '1', name: 'Main Artist' },
      },
      {
        name: 'Second Artist',
        artist: { id: '2', name: 'Second Artist' },
      },
      {
        name: 'Third Artist',
        artist: { id: '3', name: 'Third Artist' },
      },
    ];
    const result = parseArtistCredits(credits);
    expect(result.artist).toBe('Main Artist');
    expect(result.featuredArtists).toEqual(['Second Artist', 'Third Artist']);
  });
});

describe('selectBestRelease', () => {
  it('should return undefined for undefined releases', () => {
    const result = selectBestRelease(undefined);
    expect(result).toBeUndefined();
  });

  it('should return undefined for empty releases array', () => {
    const result = selectBestRelease([]);
    expect(result).toBeUndefined();
  });

  it('should return the only release when there is one', () => {
    const releases = [
      {
        id: 'r1',
        title: 'Only Album',
        date: '2020',
        status: 'Official',
      },
    ];
    const result = selectBestRelease(releases);
    expect(result?.title).toBe('Only Album');
  });

  it('should prefer official releases over non-official', () => {
    const releases = [
      {
        id: 'r1',
        title: 'Bootleg',
        date: '2018',
        status: 'Bootleg',
      },
      {
        id: 'r2',
        title: 'Official Release',
        date: '2020',
        status: 'Official',
      },
    ];
    const result = selectBestRelease(releases);
    expect(result?.title).toBe('Official Release');
  });

  it('should prefer albums over other types', () => {
    const releases = [
      {
        id: 'r1',
        title: 'The Single',
        date: '2020',
        status: 'Official',
        'release-group': { id: 'rg1', 'primary-type': 'Single' },
      },
      {
        id: 'r2',
        title: 'The Album',
        date: '2020',
        status: 'Official',
        'release-group': { id: 'rg2', 'primary-type': 'Album' },
      },
    ];
    const result = selectBestRelease(releases);
    expect(result?.title).toBe('The Album');
  });

  it('should prefer releases with dates', () => {
    const releases = [
      {
        id: 'r1',
        title: 'No Date Album',
        status: 'Official',
      },
      {
        id: 'r2',
        title: 'Dated Album',
        date: '2020-01-01',
        status: 'Official',
      },
    ];
    const result = selectBestRelease(releases);
    expect(result?.title).toBe('Dated Album');
  });

  it('should prefer earlier release dates when equal in other criteria', () => {
    const releases = [
      {
        id: 'r1',
        title: 'Later Release',
        date: '2022-05-01',
        status: 'Official',
        'release-group': { id: 'rg1', 'primary-type': 'Album' },
      },
      {
        id: 'r2',
        title: 'Earlier Release',
        date: '2019-03-15',
        status: 'Official',
        'release-group': { id: 'rg2', 'primary-type': 'Album' },
      },
    ];
    const result = selectBestRelease(releases);
    expect(result?.title).toBe('Earlier Release');
  });
});

describe('extractYear', () => {
  it('should return null for undefined date', () => {
    expect(extractYear(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(extractYear('')).toBeNull();
  });

  it('should extract year from "YYYY" format', () => {
    expect(extractYear('2020')).toBe(2020);
  });

  it('should extract year from "YYYY-MM" format', () => {
    expect(extractYear('1975-11')).toBe(1975);
  });

  it('should extract year from "YYYY-MM-DD" format', () => {
    expect(extractYear('1975-11-21')).toBe(1975);
  });

  it('should return null for non-date strings', () => {
    expect(extractYear('not-a-date')).toBeNull();
  });

  it('should return null for year below 1000', () => {
    expect(extractYear('0999')).toBeNull();
  });

  it('should accept year 1000', () => {
    expect(extractYear('1000')).toBe(1000);
  });

  it('should accept year 9999', () => {
    expect(extractYear('9999')).toBe(9999);
  });
});

describe('extractGenres', () => {
  it('should return empty array for undefined tags', () => {
    expect(extractGenres(undefined)).toEqual([]);
  });

  it('should return empty array for empty tags array', () => {
    expect(extractGenres([])).toEqual([]);
  });

  it('should extract and capitalize genre names', () => {
    const tags = [
      { name: 'rock', count: 10 },
      { name: 'pop', count: 5 },
    ];
    const genres = extractGenres(tags);
    expect(genres).toEqual(['Rock', 'Pop']);
  });

  it('should sort genres by count descending', () => {
    const tags = [
      { name: 'pop', count: 5 },
      { name: 'rock', count: 10 },
      { name: 'jazz', count: 3 },
    ];
    const genres = extractGenres(tags);
    expect(genres).toEqual(['Rock', 'Pop', 'Jazz']);
  });

  it('should filter by minimum tag count', () => {
    const tags = [
      { name: 'rock', count: 10 },
      { name: 'obscure', count: 1 },
      { name: 'rare', count: 0 },
    ];
    const genres = extractGenres(tags, 2);
    expect(genres).toEqual(['Rock']);
  });

  it('should handle multi-word genres', () => {
    const tags = [
      { name: 'classic rock', count: 10 },
      { name: 'hip hop', count: 8 },
    ];
    const genres = extractGenres(tags);
    expect(genres[0]).toBe('Classic Rock');
    expect(genres[1]).toBe('Hip Hop');
  });

  it('should handle hyphenated genres', () => {
    const tags = [{ name: 'post-punk', count: 5 }];
    const genres = extractGenres(tags);
    expect(genres[0]).toBe('Post-Punk');
  });

  it('should use default minCount of 1', () => {
    const tags = [
      { name: 'rock', count: 1 },
      { name: 'excluded', count: 0 },
    ];
    const genres = extractGenres(tags);
    expect(genres).toEqual(['Rock']);
  });
});

describe('mapResponseToMetadata', () => {
  it('should map a full response to MusicBrainzMetadata', () => {
    const response = createMockResponse();
    const metadata = mapResponseToMetadata(response);

    expect(metadata.recordingId).toBe(SAMPLE_RECORDING_ID);
    expect(metadata.title).toBe('Bohemian Rhapsody');
    expect(metadata.artist).toBe('Queen');
    expect(metadata.featuredArtists).toEqual([]);
    expect(metadata.album).toBe('A Night at the Opera');
    expect(metadata.year).toBe(1975);
    expect(metadata.genres).toEqual(['Rock', 'Classic Rock', 'Progressive Rock']);
  });

  it('should handle response with no artist credits', () => {
    const response = createMockResponse({ 'artist-credit': undefined });
    const metadata = mapResponseToMetadata(response);
    expect(metadata.artist).toBe('Unknown Artist');
    expect(metadata.featuredArtists).toEqual([]);
  });

  it('should handle response with no releases', () => {
    const response = createMockResponse({ releases: undefined });
    const metadata = mapResponseToMetadata(response);
    expect(metadata.album).toBeNull();
    expect(metadata.year).toBeNull();
  });

  it('should handle response with no tags', () => {
    const response = createMockResponse({ tags: undefined });
    const metadata = mapResponseToMetadata(response);
    expect(metadata.genres).toEqual([]);
  });

  it('should handle completely minimal response', () => {
    const response: MBRecordingResponse = {
      id: 'minimal-id',
      title: 'Minimal Song',
    };
    const metadata = mapResponseToMetadata(response);
    expect(metadata.recordingId).toBe('minimal-id');
    expect(metadata.title).toBe('Minimal Song');
    expect(metadata.artist).toBe('Unknown Artist');
    expect(metadata.album).toBeNull();
    expect(metadata.year).toBeNull();
    expect(metadata.genres).toEqual([]);
  });

  it('should respect minTagCount parameter', () => {
    const response = createMockResponse({
      tags: [
        { name: 'rock', count: 10 },
        { name: 'rare tag', count: 2 },
      ],
    });
    const metadata = mapResponseToMetadata(response, 5);
    expect(metadata.genres).toEqual(['Rock']);
  });

  it('should handle featured artists in mapping', () => {
    const response = createMockResponse({
      'artist-credit': [
        {
          name: 'Main Artist',
          joinphrase: ' feat. ',
          artist: { id: '1', name: 'Main Artist' },
        },
        {
          name: 'Featured',
          artist: { id: '2', name: 'Featured' },
        },
      ],
    });
    const metadata = mapResponseToMetadata(response);
    expect(metadata.artist).toBe('Main Artist');
    expect(metadata.featuredArtists).toEqual(['Featured']);
  });
});

describe('queryMusicBrainz', () => {
  let rateLimiter: MusicBrainzRateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = new MusicBrainzRateLimiter(0); // No delay for tests
  });

  it('should call the correct API URL with proper parameters', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    await queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter);

    expect(getMockedAxiosGet()).toHaveBeenCalledWith(
      `${DEFAULT_OPTIONS.apiBaseUrl}/recording/${SAMPLE_RECORDING_ID}`,
      expect.objectContaining({
        params: {
          inc: 'releases+artist-credits+tags',
          fmt: 'json',
        },
        headers: expect.objectContaining({
          'User-Agent': DEFAULT_OPTIONS.userAgent,
          Accept: 'application/json',
        }),
        timeout: 10000,
      }),
    );
  });

  it('should return the recording response on success', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const result = await queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter);
    expect(result).toEqual(response);
  });

  it('should use default API URL when not specified', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    await queryMusicBrainz(SAMPLE_RECORDING_ID, {}, rateLimiter);

    expect(getMockedAxiosGet()).toHaveBeenCalledWith(
      expect.stringContaining('musicbrainz.org/ws/2/recording/'),
      expect.anything(),
    );
  });

  it('should throw immediately on 404 (not found)', async () => {
    mockApiAxiosError(404);

    await expect(
      queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter),
    ).rejects.toThrow(`MusicBrainz recording not found: ${SAMPLE_RECORDING_ID}`);

    // Should NOT retry (only 1 call)
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1);
  });

  it('should throw immediately on 4xx client errors (not 429)', async () => {
    mockApiAxiosError(400, 'Bad Request');

    await expect(
      queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter),
    ).rejects.toThrow('MusicBrainz API error (400)');

    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1);
  });

  it('should retry on 5xx server errors', async () => {
    const response = createMockResponse();
    mockApiAxiosError(503, 'Service Unavailable');
    mockApiSuccess(response);

    const result = await queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter);
    expect(result).toEqual(response);
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should retry on 429 rate limit errors', async () => {
    const response = createMockResponse();
    mockApiAxiosError(429, 'Rate limited');
    mockApiSuccess(response);

    const result = await queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter);
    expect(result).toEqual(response);
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should retry on network errors', async () => {
    const response = createMockResponse();
    mockApiNetworkError('ECONNRESET');
    mockApiSuccess(response);

    const result = await queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter);
    expect(result).toEqual(response);
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should throw after all retries exhausted', async () => {
    // With maxRetries=2, there are 3 total attempts (0, 1, 2)
    mockApiAxiosError(500, 'Server Error');
    mockApiAxiosError(500, 'Server Error');
    mockApiAxiosError(500, 'Server Error');

    await expect(
      queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter),
    ).rejects.toThrow(/MusicBrainz API request failed after 3 attempts/);

    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(3);
  });

  it('should handle non-Error throws', async () => {
    getMockedAxiosGet().mockRejectedValueOnce('string error');
    getMockedAxiosGet().mockRejectedValueOnce('string error');
    getMockedAxiosGet().mockRejectedValueOnce('string error');

    await expect(
      queryMusicBrainz(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, rateLimiter),
    ).rejects.toThrow(/MusicBrainz API request failed after 3 attempts/);
  });

  it('should use default max retries when not specified', async () => {
    const response = createMockResponse();
    // Default max retries is 3, so 4 total attempts possible
    mockApiAxiosError(500, 'err');
    mockApiAxiosError(500, 'err');
    mockApiAxiosError(500, 'err');
    mockApiSuccess(response);

    const result = await queryMusicBrainz(SAMPLE_RECORDING_ID, { baseRetryDelay: 10 }, rateLimiter);
    expect(result).toEqual(response);
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(4);
  });
});

describe('fetchRecordingMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch and map recording metadata', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const metadata = await fetchRecordingMetadata(
      SAMPLE_RECORDING_ID,
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(metadata.recordingId).toBe(SAMPLE_RECORDING_ID);
    expect(metadata.title).toBe('Bohemian Rhapsody');
    expect(metadata.artist).toBe('Queen');
    expect(metadata.album).toBe('A Night at the Opera');
    expect(metadata.year).toBe(1975);
    expect(metadata.genres).toContain('Rock');
  });

  it('should use cache for repeated lookups', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const cache = new MetadataCache();
    const rateLimiter = new MusicBrainzRateLimiter(0);

    // First call - should hit API
    const metadata1 = await fetchRecordingMetadata(
      SAMPLE_RECORDING_ID,
      DEFAULT_OPTIONS,
      cache,
      rateLimiter,
    );

    // Second call - should use cache, not API
    const metadata2 = await fetchRecordingMetadata(
      SAMPLE_RECORDING_ID,
      DEFAULT_OPTIONS,
      cache,
      rateLimiter,
    );

    expect(metadata1).toEqual(metadata2);
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1); // Only 1 API call
  });

  it('should cache the result after successful fetch', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const cache = new MetadataCache();
    const rateLimiter = new MusicBrainzRateLimiter(0);

    await fetchRecordingMetadata(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, cache, rateLimiter);

    expect(cache.has(SAMPLE_RECORDING_ID)).toBe(true);
    expect(cache.get(SAMPLE_RECORDING_ID)?.title).toBe('Bohemian Rhapsody');
  });

  it('should not cache on API failure', async () => {
    mockApiAxiosError(404);

    const cache = new MetadataCache();
    const rateLimiter = new MusicBrainzRateLimiter(0);

    await expect(
      fetchRecordingMetadata(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, cache, rateLimiter),
    ).rejects.toThrow();

    expect(cache.has(SAMPLE_RECORDING_ID)).toBe(false);
  });

  it('should work without cache parameter', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const metadata = await fetchRecordingMetadata(
      SAMPLE_RECORDING_ID,
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(metadata.title).toBe('Bohemian Rhapsody');
  });

  it('should work without rate limiter parameter', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const metadata = await fetchRecordingMetadata(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS);

    expect(metadata.title).toBe('Bohemian Rhapsody');
  });

  it('should propagate API errors', async () => {
    mockApiAxiosError(500, 'Internal Server Error');
    mockApiAxiosError(500, 'Internal Server Error');
    mockApiAxiosError(500, 'Internal Server Error');

    const rateLimiter = new MusicBrainzRateLimiter(0);

    await expect(
      fetchRecordingMetadata(SAMPLE_RECORDING_ID, DEFAULT_OPTIONS, undefined, rateLimiter),
    ).rejects.toThrow(/MusicBrainz API request failed/);
  });
});

describe('fetchBestMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null for empty recording IDs array', async () => {
    const result = await fetchBestMetadata([]);
    expect(result).toBeNull();
    expect(getMockedAxiosGet()).not.toHaveBeenCalled();
  });

  it('should return metadata from the first successful recording', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const result = await fetchBestMetadata(
      [SAMPLE_RECORDING_ID],
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Bohemian Rhapsody');
  });

  it('should try next recording ID if first fails', async () => {
    const secondId = 'second-recording-id';
    const response = createMockResponse({
      id: secondId,
      title: 'Fallback Song',
    });

    mockApiAxiosError(404);
    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const result = await fetchBestMetadata(
      [SAMPLE_RECORDING_ID, secondId],
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Fallback Song');
  });

  it('should return null if all recording IDs fail', async () => {
    mockApiAxiosError(404);
    mockApiAxiosError(404);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const result = await fetchBestMetadata(
      [SAMPLE_RECORDING_ID, 'another-id'],
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(result).toBeNull();
  });

  it('should use shared cache across recordings', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    const cache = new MetadataCache();
    const rateLimiter = new MusicBrainzRateLimiter(0);

    // First call populates cache
    await fetchBestMetadata([SAMPLE_RECORDING_ID], DEFAULT_OPTIONS, cache, rateLimiter);

    // Second call with same ID should use cache
    const result = await fetchBestMetadata(
      [SAMPLE_RECORDING_ID],
      DEFAULT_OPTIONS,
      cache,
      rateLimiter,
    );

    expect(result?.title).toBe('Bohemian Rhapsody');
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1); // Only 1 API call
  });
});

describe('fetchMultipleRecordings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch metadata for multiple recording IDs', async () => {
    const secondId = 'second-id';
    const response1 = createMockResponse();
    const response2 = createMockResponse({
      id: secondId,
      title: 'Another Song',
    });

    mockApiSuccess(response1);
    mockApiSuccess(response2);

    const results = await fetchMultipleRecordings([SAMPLE_RECORDING_ID, secondId], DEFAULT_OPTIONS);

    expect(results).toHaveLength(2);
    expect(results[0].recordingId).toBe(SAMPLE_RECORDING_ID);
    expect(results[0].metadata?.title).toBe('Bohemian Rhapsody');
    expect(results[0].error).toBeNull();
    expect(results[1].recordingId).toBe(secondId);
    expect(results[1].metadata?.title).toBe('Another Song');
    expect(results[1].error).toBeNull();
  });

  it('should handle per-recording failures gracefully', async () => {
    const secondId = 'second-id';
    const response2 = createMockResponse({
      id: secondId,
      title: 'Working Song',
    });

    mockApiAxiosError(404);
    mockApiSuccess(response2);

    const results = await fetchMultipleRecordings([SAMPLE_RECORDING_ID, secondId], DEFAULT_OPTIONS);

    expect(results).toHaveLength(2);
    expect(results[0].metadata).toBeNull();
    expect(results[0].error).toContain('not found');
    expect(results[1].metadata?.title).toBe('Working Song');
    expect(results[1].error).toBeNull();
  });

  it('should handle empty recording IDs array', async () => {
    const results = await fetchMultipleRecordings([], DEFAULT_OPTIONS);
    expect(results).toEqual([]);
    expect(getMockedAxiosGet()).not.toHaveBeenCalled();
  });

  it('should use shared cache to avoid duplicate API calls', async () => {
    const response = createMockResponse();
    mockApiSuccess(response);

    // Same recording ID twice - should only make one API call
    const results = await fetchMultipleRecordings(
      [SAMPLE_RECORDING_ID, SAMPLE_RECORDING_ID],
      DEFAULT_OPTIONS,
    );

    expect(results).toHaveLength(2);
    expect(results[0].metadata?.title).toBe('Bohemian Rhapsody');
    expect(results[1].metadata?.title).toBe('Bohemian Rhapsody');
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1); // Only 1 API call
  });

  it('should handle all recordings failing', async () => {
    mockApiAxiosError(404);
    mockApiAxiosError(404);

    const results = await fetchMultipleRecordings(
      [SAMPLE_RECORDING_ID, 'another-id'],
      DEFAULT_OPTIONS,
    );

    expect(results).toHaveLength(2);
    expect(results[0].metadata).toBeNull();
    expect(results[0].error).toBeTruthy();
    expect(results[1].metadata).toBeNull();
    expect(results[1].error).toBeTruthy();
  });
});

describe('Integration (mocked API)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle a full flow: recording with featured artists', async () => {
    const response = createMockResponse({
      id: 'collab-id',
      title: 'Empire State of Mind',
      'artist-credit': [
        {
          name: 'Jay-Z',
          joinphrase: ' feat. ',
          artist: { id: 'a1', name: 'Jay-Z' },
        },
        {
          name: 'Alicia Keys',
          artist: { id: 'a2', name: 'Alicia Keys' },
        },
      ],
      releases: [
        {
          id: 'r1',
          title: 'The Blueprint 3',
          date: '2009-09-08',
          status: 'Official',
          'release-group': { id: 'rg1', 'primary-type': 'Album' },
        },
      ],
      tags: [
        { name: 'hip hop', count: 20 },
        { name: 'rap', count: 15 },
        { name: 'pop', count: 5 },
      ],
    });

    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const metadata = await fetchRecordingMetadata(
      'collab-id',
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(metadata.title).toBe('Empire State of Mind');
    expect(metadata.artist).toBe('Jay-Z');
    expect(metadata.featuredArtists).toEqual(['Alicia Keys']);
    expect(metadata.album).toBe('The Blueprint 3');
    expect(metadata.year).toBe(2009);
    expect(metadata.genres).toContain('Hip Hop');
    expect(metadata.genres).toContain('Rap');
    expect(metadata.genres).toContain('Pop');
  });

  it('should handle a recording with incomplete data', async () => {
    const response: MBRecordingResponse = {
      id: 'incomplete-id',
      title: 'Mystery Track',
      // No artist credits, releases, or tags
    };

    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const metadata = await fetchRecordingMetadata(
      'incomplete-id',
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(metadata.title).toBe('Mystery Track');
    expect(metadata.artist).toBe('Unknown Artist');
    expect(metadata.album).toBeNull();
    expect(metadata.year).toBeNull();
    expect(metadata.genres).toEqual([]);
  });

  it('should select best album from multiple releases', async () => {
    const response = createMockResponse({
      releases: [
        {
          id: 'r1',
          title: 'Greatest Hits',
          date: '2000',
          status: 'Official',
          'release-group': { id: 'rg1', 'primary-type': 'Compilation' },
        },
        {
          id: 'r2',
          title: 'Original Album',
          date: '1975',
          status: 'Official',
          'release-group': { id: 'rg2', 'primary-type': 'Album' },
        },
        {
          id: 'r3',
          title: 'Bootleg Album',
          date: '1976',
          status: 'Bootleg',
          'release-group': { id: 'rg3', 'primary-type': 'Album' },
        },
      ],
    });

    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const metadata = await fetchRecordingMetadata(
      SAMPLE_RECORDING_ID,
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    // Should prefer official album over compilation and bootleg
    expect(metadata.album).toBe('Original Album');
    expect(metadata.year).toBe(1975);
  });

  it('should handle fetchBestMetadata with fallback', async () => {
    // First recording fails, second succeeds
    mockApiAxiosError(404);

    const response = createMockResponse({
      id: 'fallback-id',
      title: 'Found It',
    });
    mockApiSuccess(response);

    const rateLimiter = new MusicBrainzRateLimiter(0);
    const metadata = await fetchBestMetadata(
      ['missing-id', 'fallback-id'],
      DEFAULT_OPTIONS,
      undefined,
      rateLimiter,
    );

    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe('Found It');
  });
});
