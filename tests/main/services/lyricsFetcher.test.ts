/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  LyricsCache,
  LyricsFetcherOptions,
  LRCLIBResult,
  cleanLyrics,
  validateLyricsMatch,
  queryLRCLIB,
  searchLRCLIB,
  queryChartLyrics,
  fetchLyrics,
  fetchMultipleLyrics,
} from '../../../src/main/services/lyricsFetcher';

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

vi.mock('../../../src/main/services/geniusFetcher', () => ({
  queryGeniusLyrics: vi.fn().mockResolvedValue(null),
  GeniusRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
    handleRetryAfter: vi.fn(),
  })),
}));

/** Get the mocked axios.get function */
function getMockedAxiosGet(): ReturnType<typeof vi.mocked<typeof axios.get>> {
  return vi.mocked(axios.get);
}

/** Default test options */
const DEFAULT_OPTIONS: LyricsFetcherOptions = {
  lrclibBaseUrl: 'https://test-lrclib.net/api',
  chartLyricsBaseUrl: 'https://test-chartlyrics.com/apiv1.asmx',
  maxRetries: 1,
  baseRetryDelay: 10, // Very short for tests
  requestTimeout: 5000,
  userAgent: 'TestAgent/1.0',
  skipGenius: true, // Disable Genius in all existing tests (no token configured)
};

/** Create a mock LRCLIB result */
function createMockLRCLIBResult(overrides: Partial<LRCLIBResult> = {}): LRCLIBResult {
  return {
    id: 1,
    trackName: 'Bohemian Rhapsody',
    artistName: 'Queen',
    albumName: 'A Night at the Opera',
    duration: 354,
    instrumental: false,
    plainLyrics:
      'Is this the real life?\nIs this just fantasy?\nCaught in a landslide\nNo escape from reality',
    syncedLyrics: null,
    ...overrides,
  };
}

/** Create a mock Axios error */
function createAxiosError(
  status: number,
  message: string = 'Request failed',
): {
  isAxiosError: true;
  message: string;
  response: { status: number; data: unknown };
} & Error {
  const err = new Error(message) as Error & {
    isAxiosError: true;
    response: { status: number; data: unknown };
  };
  err.isAxiosError = true;
  err.response = { status, data: {} };
  return err;
}

/** Create a network error (no response) */
function createNetworkError(message: string = 'Network Error'): Error & { isAxiosError: true } {
  const err = new Error(message) as Error & { isAxiosError: true };
  err.isAxiosError = true;
  return err;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LyricsCache', () => {
  let cache: LyricsCache;

  beforeEach(() => {
    cache = new LyricsCache();
  });

  it('should store and retrieve lyrics by artist and title', () => {
    const result = {
      lyrics: 'Some lyrics',
      source: 'lrclib' as const,
      validated: true,
    };
    cache.set('Queen', 'Bohemian Rhapsody', result);
    expect(cache.has('Queen', 'Bohemian Rhapsody')).toBe(true);
    expect(cache.get('Queen', 'Bohemian Rhapsody')).toEqual(result);
  });

  it('should normalize keys to lowercase and trimmed', () => {
    const result = {
      lyrics: 'Test lyrics',
      source: 'lrclib' as const,
      validated: true,
    };
    cache.set('  Queen  ', '  Bohemian Rhapsody  ', result);
    expect(cache.has('queen', 'bohemian rhapsody')).toBe(true);
    expect(cache.get('QUEEN', 'BOHEMIAN RHAPSODY')).toEqual(result);
  });

  it('should return undefined for uncached lookups', () => {
    expect(cache.get('Queen', 'Bohemian Rhapsody')).toBeUndefined();
    expect(cache.has('Queen', 'Bohemian Rhapsody')).toBe(false);
  });

  it('should store null results (meaning no lyrics found)', () => {
    cache.set('NoLyrics', 'Artist', null);
    expect(cache.has('NoLyrics', 'Artist')).toBe(true);
    expect(cache.get('NoLyrics', 'Artist')).toBeNull();
  });

  it('should delete cached entries', () => {
    cache.set('Queen', 'Bohemian Rhapsody', {
      lyrics: 'Test',
      source: 'lrclib',
      validated: true,
    });
    expect(cache.delete('Queen', 'Bohemian Rhapsody')).toBe(true);
    expect(cache.has('Queen', 'Bohemian Rhapsody')).toBe(false);
  });

  it('should return false when deleting non-existent entry', () => {
    expect(cache.delete('NonExistent', 'Song')).toBe(false);
  });

  it('should clear all cached entries', () => {
    cache.set('Artist1', 'Song1', {
      lyrics: 'A',
      source: 'lrclib',
      validated: true,
    });
    cache.set('Artist2', 'Song2', {
      lyrics: 'B',
      source: 'chartlyrics',
      validated: false,
    });
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('should report correct size', () => {
    expect(cache.size).toBe(0);
    cache.set('A', 'B', { lyrics: 'X', source: 'lrclib', validated: true });
    expect(cache.size).toBe(1);
    cache.set('C', 'D', { lyrics: 'Y', source: 'lrclib', validated: true });
    expect(cache.size).toBe(2);
  });

  it('should overwrite existing entries', () => {
    cache.set('Queen', 'Song', {
      lyrics: 'Old',
      source: 'lrclib',
      validated: true,
    });
    cache.set('Queen', 'Song', {
      lyrics: 'New',
      source: 'chartlyrics',
      validated: false,
    });
    expect(cache.size).toBe(1);
    expect(cache.get('Queen', 'Song')?.lyrics).toBe('New');
  });

  it('should generate consistent cache keys', () => {
    expect(LyricsCache.makeKey('Queen', 'Test')).toBe('queen|test');
    expect(LyricsCache.makeKey('  Queen  ', '  Test  ')).toBe('queen|test');
  });
});

describe('cleanLyrics', () => {
  it('should return empty string for null/undefined/empty input', () => {
    expect(cleanLyrics('')).toBe('');
    expect(cleanLyrics('   ')).toBe('');
    expect(cleanLyrics('\n\n\n')).toBe('');
  });

  it('should trim leading and trailing whitespace', () => {
    expect(cleanLyrics('  Hello world  ')).toBe('Hello world');
  });

  it('should normalize line endings', () => {
    expect(cleanLyrics('line1\r\nline2\rline3\nline4')).toBe('line1\nline2\nline3\nline4');
  });

  it('should collapse multiple blank lines to a single blank line', () => {
    expect(cleanLyrics('verse 1\n\n\n\n\nverse 2')).toBe('verse 1\n\nverse 2');
  });

  it('should remove copyright notices', () => {
    const input = 'Some lyrics\nCopyright © 2024 Record Label\nMore lyrics';
    const result = cleanLyrics(input);
    expect(result).not.toContain('Copyright');
    expect(result).toContain('Some lyrics');
    expect(result).toContain('More lyrics');
  });

  it('should remove "all rights reserved" lines', () => {
    const input = 'Verse 1\nAll Rights Reserved.\nVerse 2';
    const result = cleanLyrics(input);
    expect(result).not.toContain('All Rights Reserved');
  });

  it('should remove "lyrics provided by" lines', () => {
    const input = 'Some lyrics\nLyrics provided by LyricFind\nMore lyrics';
    const result = cleanLyrics(input);
    expect(result).not.toContain('LyricFind');
  });

  it('should remove "lyrics powered by" lines', () => {
    const input = 'Lyrics\nLyrics powered by SomeService\nMore';
    const result = cleanLyrics(input);
    expect(result).not.toContain('powered by');
  });

  it('should remove URLs', () => {
    const input = 'Lyrics\nhttps://example.com\nhttp://test.com\nMore';
    const result = cleanLyrics(input);
    expect(result).not.toContain('http');
  });

  it('should remove www lines', () => {
    const input = 'Lyrics\nwww.example.com\nMore';
    const result = cleanLyrics(input);
    expect(result).not.toContain('www');
  });

  it('should remove (c) year lines', () => {
    const input = 'Lyrics\n(c) 2024 Sony Music\nMore';
    const result = cleanLyrics(input);
    expect(result).not.toContain('2024 Sony');
  });

  it('should remove advertisement lines', () => {
    const input = 'Lyrics\nAdvertisement\nMore lyrics';
    const result = cleanLyrics(input);
    expect(result).not.toContain('Advertisement');
  });

  it('should remove separator lines (*** and ---)', () => {
    const input = 'Lyrics\n***\n---\nMore';
    const result = cleanLyrics(input);
    expect(result).not.toContain('***');
    expect(result).not.toContain('---');
  });

  it('should trim trailing whitespace from each line', () => {
    const input = 'line1   \nline2   \nline3   ';
    expect(cleanLyrics(input)).toBe('line1\nline2\nline3');
  });

  it('should preserve normal lyrics structure', () => {
    const input =
      'Is this the real life?\nIs this just fantasy?\n\nCaught in a landslide\nNo escape from reality';
    expect(cleanLyrics(input)).toBe(input);
  });
});

describe('validateLyricsMatch', () => {
  it('should return true when both artist and title match exactly', () => {
    expect(validateLyricsMatch('Queen', 'Bohemian Rhapsody', 'Queen', 'Bohemian Rhapsody')).toBe(
      true,
    );
  });

  it('should return true with case-insensitive matching', () => {
    expect(validateLyricsMatch('queen', 'bohemian rhapsody', 'Queen', 'Bohemian Rhapsody')).toBe(
      true,
    );
  });

  it('should return true when response contains query as substring', () => {
    expect(validateLyricsMatch('Queen', 'Bohemian', 'Queen', 'Bohemian Rhapsody')).toBe(true);
  });

  it('should return true when query contains response as substring', () => {
    expect(
      validateLyricsMatch('Queen Band', 'Bohemian Rhapsody Live', 'Queen', 'Bohemian Rhapsody'),
    ).toBe(true);
  });

  it('should return true when both response fields are null/undefined', () => {
    expect(validateLyricsMatch('Queen', 'Test', null, null)).toBe(true);
    expect(validateLyricsMatch('Queen', 'Test', undefined, undefined)).toBe(true);
  });

  it('should return true when response artist is empty (accepts title-only match)', () => {
    expect(validateLyricsMatch('Queen', 'Bohemian Rhapsody', '', 'Bohemian Rhapsody')).toBe(true);
  });

  it('should return true when response title is empty (accepts artist-only match)', () => {
    expect(validateLyricsMatch('Queen', 'Bohemian Rhapsody', 'Queen', '')).toBe(true);
  });

  it('should return false when neither artist nor title match', () => {
    expect(validateLyricsMatch('Queen', 'Bohemian Rhapsody', 'Beatles', 'Yesterday')).toBe(false);
  });

  it('should return false when artist matches but title does not', () => {
    expect(validateLyricsMatch('Queen', 'Bohemian Rhapsody', 'Queen', 'Yesterday')).toBe(false);
  });

  it('should handle whitespace in inputs', () => {
    expect(
      validateLyricsMatch('  Queen  ', '  Bohemian Rhapsody  ', 'Queen', 'Bohemian Rhapsody'),
    ).toBe(true);
  });
});

describe('queryLRCLIB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send correct params to LRCLIB API', async () => {
    const mockResult = createMockLRCLIBResult();
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockResult });

    await queryLRCLIB('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(getMockedAxiosGet()).toHaveBeenCalledWith(
      'https://test-lrclib.net/api/get',
      expect.objectContaining({
        params: {
          track_name: 'Bohemian Rhapsody',
          artist_name: 'Queen',
        },
        headers: expect.objectContaining({
          'User-Agent': 'TestAgent/1.0',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('should return LRCLIB result on success', async () => {
    const mockResult = createMockLRCLIBResult();
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockResult });

    const result = await queryLRCLIB('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result).toEqual(mockResult);
  });

  it('should return null on 404', async () => {
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));

    const result = await queryLRCLIB('Unknown', 'Unknown', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should return null on 4xx errors (no retry)', async () => {
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(400));

    const result = await queryLRCLIB('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1);
  });

  it('should retry on 5xx errors', async () => {
    getMockedAxiosGet()
      .mockRejectedValueOnce(createAxiosError(500))
      .mockResolvedValueOnce({ data: createMockLRCLIBResult() });

    const result = await queryLRCLIB('Queen', 'Test', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should retry on 429 rate limit errors', async () => {
    getMockedAxiosGet()
      .mockRejectedValueOnce(createAxiosError(429))
      .mockResolvedValueOnce({ data: createMockLRCLIBResult() });

    const result = await queryLRCLIB('Queen', 'Test', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should retry on network errors', async () => {
    getMockedAxiosGet()
      .mockRejectedValueOnce(createNetworkError())
      .mockResolvedValueOnce({ data: createMockLRCLIBResult() });

    const result = await queryLRCLIB('Queen', 'Test', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should return null after all retries exhausted', async () => {
    getMockedAxiosGet()
      .mockRejectedValueOnce(createAxiosError(500))
      .mockRejectedValueOnce(createAxiosError(500));

    const result = await queryLRCLIB('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should return null when response data is null/empty', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({ data: null });

    const result = await queryLRCLIB('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should use default API URL when not provided in options', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({
      data: createMockLRCLIBResult(),
    });

    await queryLRCLIB('Queen', 'Test', {});

    expect(getMockedAxiosGet()).toHaveBeenCalledWith(
      'https://lrclib.net/api/get',
      expect.anything(),
    );
  });
});

describe('searchLRCLIB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send correct params to LRCLIB search endpoint', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });

    await searchLRCLIB('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(getMockedAxiosGet()).toHaveBeenCalledWith(
      'https://test-lrclib.net/api/search',
      expect.objectContaining({
        params: {
          track_name: 'Bohemian Rhapsody',
          artist_name: 'Queen',
        },
      }),
    );
  });

  it('should return the best validated match from search results', async () => {
    const results = [
      createMockLRCLIBResult({
        id: 1,
        trackName: 'Different Song',
        artistName: 'Different Artist',
        plainLyrics: 'Wrong lyrics',
      }),
      createMockLRCLIBResult({
        id: 2,
        trackName: 'Bohemian Rhapsody',
        artistName: 'Queen',
        plainLyrics: 'Correct lyrics',
      }),
    ];
    getMockedAxiosGet().mockResolvedValueOnce({ data: results });

    const result = await searchLRCLIB('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result?.id).toBe(2);
    expect(result?.plainLyrics).toBe('Correct lyrics');
  });

  it('should return first result if no validated match found', async () => {
    const results = [
      createMockLRCLIBResult({
        id: 1,
        trackName: 'Something Else',
        artistName: 'Someone Else',
        plainLyrics: 'Some lyrics',
      }),
    ];
    getMockedAxiosGet().mockResolvedValueOnce({ data: results });

    const result = await searchLRCLIB('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result?.id).toBe(1);
  });

  it('should filter out instrumental results', async () => {
    const results = [
      createMockLRCLIBResult({
        id: 1,
        instrumental: true,
        plainLyrics: 'Not real lyrics',
      }),
      createMockLRCLIBResult({
        id: 2,
        instrumental: false,
        plainLyrics: 'Real lyrics',
      }),
    ];
    getMockedAxiosGet().mockResolvedValueOnce({ data: results });

    const result = await searchLRCLIB('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result?.id).toBe(2);
  });

  it('should filter out results without plainLyrics', async () => {
    const results = [
      createMockLRCLIBResult({
        id: 1,
        plainLyrics: null,
      }),
      createMockLRCLIBResult({
        id: 2,
        plainLyrics: 'Has lyrics',
      }),
    ];
    getMockedAxiosGet().mockResolvedValueOnce({ data: results });

    const result = await searchLRCLIB('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result?.id).toBe(2);
  });

  it('should return null for empty search results', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });

    const result = await searchLRCLIB('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should return null on 404', async () => {
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));

    const result = await searchLRCLIB('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should retry on 5xx errors', async () => {
    getMockedAxiosGet()
      .mockRejectedValueOnce(createAxiosError(500))
      .mockResolvedValueOnce({
        data: [createMockLRCLIBResult()],
      });

    const result = await searchLRCLIB('Queen', 'Test', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });
});

describe('queryChartLyrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send correct params to ChartLyrics API', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [
        {
          LyricId: 1,
          LyricSong: 'Bohemian Rhapsody',
          LyricArtist: 'Queen',
          Lyric: 'Some lyrics text',
        },
      ],
    });

    await queryChartLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(getMockedAxiosGet()).toHaveBeenCalledWith(
      'https://test-chartlyrics.com/apiv1.asmx/SearchLyricDirect',
      expect.objectContaining({
        params: {
          artist: 'Queen',
          song: 'Bohemian Rhapsody',
        },
      }),
    );
  });

  it('should return lyrics from array response', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [
        {
          LyricId: 1,
          LyricSong: 'Bohemian Rhapsody',
          LyricArtist: 'Queen',
          Lyric: 'Is this the real life?',
        },
      ],
    });

    const result = await queryChartLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.lyrics).toBe('Is this the real life?');
    expect(result?.artist).toBe('Queen');
    expect(result?.title).toBe('Bohemian Rhapsody');
  });

  it('should handle single object response', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({
      data: {
        LyricId: 1,
        LyricSong: 'Test Song',
        LyricArtist: 'Test Artist',
        Lyric: 'Test lyrics',
      },
    });

    const result = await queryChartLyrics('Test Artist', 'Test Song', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.lyrics).toBe('Test lyrics');
  });

  it('should return null when no lyrics in results', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [
        {
          LyricId: 1,
          LyricSong: 'Test',
          LyricArtist: 'Test',
          Lyric: '',
        },
      ],
    });

    const result = await queryChartLyrics('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should return null on empty array', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });

    const result = await queryChartLyrics('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should return null on 4xx errors', async () => {
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(400));

    const result = await queryChartLyrics('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should retry on 5xx errors', async () => {
    getMockedAxiosGet()
      .mockRejectedValueOnce(createAxiosError(500))
      .mockResolvedValueOnce({
        data: [{ Lyric: 'Recovered lyrics', LyricSong: 'Test', LyricArtist: 'Test' }],
      });

    const result = await queryChartLyrics('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should return null after all retries exhausted', async () => {
    getMockedAxiosGet()
      .mockRejectedValueOnce(createAxiosError(500))
      .mockRejectedValueOnce(createAxiosError(500));

    const result = await queryChartLyrics('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should handle missing LyricArtist and LyricSong gracefully', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [{ Lyric: 'Just lyrics', LyricId: 1 }],
    });

    const result = await queryChartLyrics('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.lyrics).toBe('Just lyrics');
    expect(result?.artist).toBe('');
    expect(result?.title).toBe('');
  });
});

describe('fetchLyrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null for empty artist', async () => {
    const result = await fetchLyrics('', 'Test', DEFAULT_OPTIONS);
    expect(result).toBeNull();
  });

  it('should return null for empty title', async () => {
    const result = await fetchLyrics('Test', '', DEFAULT_OPTIONS);
    expect(result).toBeNull();
  });

  it('should return null for whitespace-only inputs', async () => {
    const result = await fetchLyrics('   ', '   ', DEFAULT_OPTIONS);
    expect(result).toBeNull();
  });

  it('should return LRCLIB exact match result', async () => {
    const mockLrclib = createMockLRCLIBResult();
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });

    const result = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.source).toBe('lrclib');
    expect(result?.lyrics).toContain('Is this the real life?');
    expect(result?.validated).toBe(true);
  });

  it('should fall back to LRCLIB search when exact match fails', async () => {
    // Exact match: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    // Search: success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [createMockLRCLIBResult()],
    });

    const result = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.source).toBe('lrclib');
  });

  it('should fall back to ChartLyrics when LRCLIB fails', async () => {
    // LRCLIB exact: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    // LRCLIB search: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // ChartLyrics: success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [
        {
          LyricId: 1,
          LyricSong: 'Bohemian Rhapsody',
          LyricArtist: 'Queen',
          Lyric: 'Is this the real life?\nIs this just fantasy?',
        },
      ],
    });

    const result = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.source).toBe('chartlyrics');
    expect(result?.validated).toBe(true);
  });

  it('should skip ChartLyrics when skipChartLyrics option is set', async () => {
    // LRCLIB exact: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    // LRCLIB search: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });

    const result = await fetchLyrics('Queen', 'Test', {
      ...DEFAULT_OPTIONS,
      skipChartLyrics: true,
    });

    expect(result).toBeNull();
    // Only 2 calls (LRCLIB exact + search), no ChartLyrics
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
  });

  it('should return null when all sources fail', async () => {
    // LRCLIB exact: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    // LRCLIB search: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // ChartLyrics: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));

    const result = await fetchLyrics('Unknown', 'Unknown', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should use cache for subsequent calls', async () => {
    const cache = new LyricsCache();
    const mockLrclib = createMockLRCLIBResult();
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });

    // First call: fetches from API
    const result1 = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS, cache);
    expect(result1).not.toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1);

    // Second call: from cache
    const result2 = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS, cache);
    expect(result2).not.toBeNull();
    expect(result2).toEqual(result1);
    // No additional API calls
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1);
  });

  it('should cache null results to avoid redundant API calls', async () => {
    const cache = new LyricsCache();
    // LRCLIB exact: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    // LRCLIB search: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // ChartLyrics: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });

    const result1 = await fetchLyrics('NoLyrics', 'Artist', DEFAULT_OPTIONS, cache);
    expect(result1).toBeNull();

    // Second call should use cache
    const result2 = await fetchLyrics('NoLyrics', 'Artist', DEFAULT_OPTIONS, cache);
    expect(result2).toBeNull();
    // Only 3 calls total (from first invocation)
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(3);
  });

  it('should clean up lyrics before returning', async () => {
    const mockLrclib = createMockLRCLIBResult({
      plainLyrics:
        'Great lyrics\r\nCopyright © 2024 Sony\r\nhttps://example.com\r\n\r\n\r\n\r\nMore lyrics  ',
    });
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });

    const result = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.lyrics).not.toContain('Copyright');
    expect(result?.lyrics).not.toContain('https://');
    expect(result?.lyrics).toBe('Great lyrics\n\nMore lyrics');
  });

  it('should skip instrumental tracks from LRCLIB', async () => {
    const mockLrclib = createMockLRCLIBResult({
      instrumental: true,
      plainLyrics: 'Not real lyrics',
    });
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });
    // LRCLIB search: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // ChartLyrics: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });

    const result = await fetchLyrics('Test', 'Instrumental', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should skip results with empty plainLyrics', async () => {
    const mockLrclib = createMockLRCLIBResult({
      plainLyrics: '',
    });
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });
    // LRCLIB search: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // ChartLyrics: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });

    const result = await fetchLyrics('Test', 'Test', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should trim artist and title before processing', async () => {
    const mockLrclib = createMockLRCLIBResult();
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });

    const result = await fetchLyrics('  Queen  ', '  Bohemian Rhapsody  ', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(getMockedAxiosGet()).toHaveBeenCalledWith(
      expect.stringContaining('/get'),
      expect.objectContaining({
        params: {
          track_name: 'Bohemian Rhapsody',
          artist_name: 'Queen',
        },
      }),
    );
  });

  it('should mark lyrics as not validated when metadata does not match', async () => {
    const mockLrclib = createMockLRCLIBResult({
      artistName: 'Completely Different',
      trackName: 'Also Different',
    });
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });

    const result = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.validated).toBe(false);
  });
});

describe('fetchMultipleLyrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process multiple songs', async () => {
    // Song 1: LRCLIB success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: createMockLRCLIBResult({
        trackName: 'Song1',
        artistName: 'Artist1',
        plainLyrics: 'Lyrics for song 1',
      }),
    });
    // Song 2: LRCLIB success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: createMockLRCLIBResult({
        trackName: 'Song2',
        artistName: 'Artist2',
        plainLyrics: 'Lyrics for song 2',
      }),
    });

    const songs = [
      { artist: 'Artist1', title: 'Song1' },
      { artist: 'Artist2', title: 'Song2' },
    ];

    const results = await fetchMultipleLyrics(songs, DEFAULT_OPTIONS);

    expect(results).toHaveLength(2);
    expect(results[0].result).not.toBeNull();
    expect(results[0].result?.lyrics).toContain('Lyrics for song 1');
    expect(results[0].error).toBeNull();
    expect(results[1].result).not.toBeNull();
    expect(results[1].result?.lyrics).toContain('Lyrics for song 2');
    expect(results[1].error).toBeNull();
  });

  it('should handle per-song failures without stopping batch', async () => {
    // Song 1: LRCLIB 404, search empty, ChartLyrics empty (all fail)
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // Song 2: LRCLIB success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: createMockLRCLIBResult({
        trackName: 'Song2',
        artistName: 'Artist2',
        plainLyrics: 'Found lyrics',
      }),
    });

    const songs = [
      { artist: 'Unknown', title: 'Unknown' },
      { artist: 'Artist2', title: 'Song2' },
    ];

    const results = await fetchMultipleLyrics(songs, DEFAULT_OPTIONS);

    expect(results).toHaveLength(2);
    expect(results[0].result).toBeNull();
    expect(results[0].error).toBeNull(); // null result is not an error
    expect(results[1].result).not.toBeNull();
  });

  it('should return empty array for empty input', async () => {
    const results = await fetchMultipleLyrics([], DEFAULT_OPTIONS);
    expect(results).toEqual([]);
  });

  it('should use shared cache across songs', async () => {
    // Song 1: LRCLIB success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: createMockLRCLIBResult({
        trackName: 'Same Song',
        artistName: 'Same Artist',
        plainLyrics: 'Shared lyrics',
      }),
    });

    // Same song requested twice
    const songs = [
      { artist: 'Same Artist', title: 'Same Song' },
      { artist: 'Same Artist', title: 'Same Song' },
    ];

    const results = await fetchMultipleLyrics(songs, DEFAULT_OPTIONS);

    expect(results).toHaveLength(2);
    expect(results[0].result?.lyrics).toBe('Shared lyrics');
    expect(results[1].result?.lyrics).toBe('Shared lyrics');
    // Only 1 API call (second uses cache)
    expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1);
  });

  it('should preserve artist and title in results', async () => {
    getMockedAxiosGet().mockResolvedValueOnce({
      data: createMockLRCLIBResult(),
    });

    const songs = [{ artist: 'Queen', title: 'Bohemian Rhapsody' }];
    const results = await fetchMultipleLyrics(songs, DEFAULT_OPTIONS);

    expect(results[0].artist).toBe('Queen');
    expect(results[0].title).toBe('Bohemian Rhapsody');
  });
});

describe('Integration (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle full flow: LRCLIB exact match → clean → validate → return', async () => {
    const mockLrclib = createMockLRCLIBResult({
      plainLyrics:
        'Is this the real life?\nIs this just fantasy?\n\nCaught in a landslide\nNo escape from reality\n\nCopyright © 2024 EMI Records',
    });
    getMockedAxiosGet().mockResolvedValueOnce({ data: mockLrclib });

    const cache = new LyricsCache();
    const result = await fetchLyrics('Queen', 'Bohemian Rhapsody', DEFAULT_OPTIONS, cache);

    expect(result).not.toBeNull();
    expect(result?.source).toBe('lrclib');
    expect(result?.validated).toBe(true);
    expect(result?.lyrics).not.toContain('Copyright');
    expect(result?.lyrics).toContain('Is this the real life?');
    expect(result?.lyrics).toContain('No escape from reality');
    // Verify it was cached
    expect(cache.has('Queen', 'Bohemian Rhapsody')).toBe(true);
  });

  it('should handle full fallback flow: LRCLIB fail → search fail → ChartLyrics → return', async () => {
    // LRCLIB exact: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    // LRCLIB search: empty results
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // ChartLyrics: success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [
        {
          LyricId: 42,
          LyricSong: 'Yesterday',
          LyricArtist: 'The Beatles',
          Lyric:
            "Yesterday, all my troubles seemed so far away\nNow it looks as though they're here to stay\n\nOh, I believe in yesterday",
        },
      ],
    });

    const result = await fetchLyrics('The Beatles', 'Yesterday', DEFAULT_OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.source).toBe('chartlyrics');
    expect(result?.validated).toBe(true);
    expect(result?.lyrics).toContain('Yesterday');
    expect(result?.lyrics).toContain('Oh, I believe in yesterday');
  });

  it('should return null for completely unfindable lyrics', async () => {
    // LRCLIB exact: 404
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    // LRCLIB search: empty
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    // ChartLyrics: 500 then 500 (exhausted retries)
    getMockedAxiosGet()
      .mockRejectedValueOnce(createAxiosError(500))
      .mockRejectedValueOnce(createAxiosError(500));

    const result = await fetchLyrics('Obscure Artist', 'Unreleased Track', DEFAULT_OPTIONS);

    expect(result).toBeNull();
  });

  it('should handle batch processing with mixed results', async () => {
    // Song 1: Full LRCLIB success
    getMockedAxiosGet().mockResolvedValueOnce({
      data: createMockLRCLIBResult({
        trackName: 'Song A',
        artistName: 'Artist A',
        plainLyrics: 'Lyrics A',
      }),
    });
    // Song 2: Invalid inputs
    // Song 3: LRCLIB 404 → search empty → ChartLyrics success
    getMockedAxiosGet().mockRejectedValueOnce(createAxiosError(404));
    getMockedAxiosGet().mockResolvedValueOnce({ data: [] });
    getMockedAxiosGet().mockResolvedValueOnce({
      data: [{ Lyric: 'Lyrics C', LyricSong: 'Song C', LyricArtist: 'Artist C' }],
    });

    const songs = [
      { artist: 'Artist A', title: 'Song A' },
      { artist: '', title: '' }, // Invalid
      { artist: 'Artist C', title: 'Song C' },
    ];

    const results = await fetchMultipleLyrics(songs, DEFAULT_OPTIONS);

    expect(results).toHaveLength(3);
    expect(results[0].result?.source).toBe('lrclib');
    expect(results[0].result?.lyrics).toBe('Lyrics A');
    expect(results[1].result).toBeNull(); // Invalid inputs
    expect(results[2].result?.source).toBe('chartlyrics');
    expect(results[2].result?.lyrics).toBe('Lyrics C');
  });
});
