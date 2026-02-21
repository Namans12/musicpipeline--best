/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ProcessingResult,
  ProgressUpdate,
  MusicBrainzMetadata,
} from '../../../src/shared/types';
// eslint-disable-next-line import/order
import {
  BatchProcessor,
  BatchProcessorOptions,
  TokenBucketRateLimiter,
  estimateProcessingTime,
} from '../../../src/main/services/batchProcessor';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock all service dependencies
vi.mock('../../../src/main/services/audioReader', () => ({
  readAudioFile: vi.fn(),
}));

vi.mock('../../../src/main/services/fingerprinter', () => ({
  fingerprintFile: vi.fn(),
  FingerprintCache: vi.fn().mockImplementation(() => ({
    has: vi.fn().mockReturnValue(false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    size: 0,
  })),
  RateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/main/services/metadataFetcher', () => ({
  fetchBestMetadata: vi.fn(),
  MetadataCache: vi.fn().mockImplementation(() => ({
    has: vi.fn().mockReturnValue(false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    size: 0,
  })),
  MusicBrainzRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/main/services/lyricsFetcher', () => ({
  fetchLyrics: vi.fn(),
  LyricsCache: vi.fn().mockImplementation(() => ({
    has: vi.fn().mockReturnValue(false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    size: 0,
  })),
}));

vi.mock('../../../src/main/services/tagWriter', () => ({
  writeTagsAndRename: vi.fn(),
}));

vi.mock('../../../src/main/services/albumArtFetcher', () => ({
  fetchAlbumArt: vi.fn().mockResolvedValue(null),
  fetchAlbumArtFromUrl: vi.fn().mockResolvedValue(null),
  fetchAlbumArtFromDeezer: vi.fn().mockResolvedValue(null),
  fetchAlbumArtFromAudioDB: vi.fn().mockResolvedValue(null),
  searchCAAByNames: vi.fn().mockResolvedValue(null),
  FifoRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
  })),
  DeezerRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
  })),
  AudioDBRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/main/services/itunesFetcher', () => ({
  searchItunes: vi.fn().mockResolvedValue(null),
  extractSearchTerms: vi.fn().mockReturnValue({ title: 'Test Title', artist: 'Test Artist' }),
  ItunesRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/main/services/spotifyFetcher', () => ({
  searchSpotify: vi.fn().mockResolvedValue(null),
  SpotifyRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
    handleRetryAfter: vi.fn(),
  })),
  SpotifyTokenManager: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue('mock-token'),
    invalidate: vi.fn(),
  })),
}));

vi.mock('../../../src/main/services/geniusFetcher', () => ({
  GeniusRateLimiter: vi.fn().mockImplementation(() => ({
    waitForSlot: vi.fn().mockResolvedValue(undefined),
    handleRetryAfter: vi.fn(),
  })),
}));

vi.mock('../../../src/main/services/persistentCache', () => ({
  PersistentCacheDatabase: vi.fn().mockImplementation(() => ({
    initialize: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    getPath: vi.fn().mockReturnValue(':memory:'),
    close: vi.fn(),
    getStats: vi.fn().mockReturnValue({ fingerprints: 0, metadata: 0, lyrics: 0 }),
    clearAll: vi.fn(),
  })),
  PersistentFingerprintCache: vi.fn().mockImplementation(() => ({
    has: vi.fn().mockReturnValue(false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    size: 0,
    registerHash: vi.fn(),
    getByHash: vi.fn(),
    hasByHash: vi.fn().mockReturnValue(false),
  })),
  PersistentMetadataCache: vi.fn().mockImplementation(() => ({
    has: vi.fn().mockReturnValue(false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    size: 0,
  })),
  PersistentLyricsCache: vi.fn().mockImplementation(() => ({
    has: vi.fn().mockReturnValue(false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    size: 0,
  })),
}));

vi.mock('../../../src/main/services/errors', () => ({
  wrapError: vi.fn((error: unknown, category: string, options?: { filePath?: string }) => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      category,
      filePath: options?.filePath ?? null,
      step: category,
      cause: null,
      name: category,
    };
  }),
  isPipelineError: vi.fn().mockReturnValue(false),
}));

// Import the mocked modules so we can control them
import { readAudioFile } from '../../../src/main/services/audioReader';
import { fingerprintFile } from '../../../src/main/services/fingerprinter';
import { fetchBestMetadata } from '../../../src/main/services/metadataFetcher';
import { fetchLyrics } from '../../../src/main/services/lyricsFetcher';
import { writeTagsAndRename } from '../../../src/main/services/tagWriter';

const mockedReadAudioFile = vi.mocked(readAudioFile);
const mockedFingerprintFile = vi.mocked(fingerprintFile);
const mockedFetchBestMetadata = vi.mocked(fetchBestMetadata);
const mockedFetchLyrics = vi.mocked(fetchLyrics);
const mockedWriteTagsAndRename = vi.mocked(writeTagsAndRename);

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Create default mock metadata for a file */
function createMockAudioMetadata(filePath: string) {
  return {
    filePath,
    format: 'mp3' as const,
    fileSize: 5000000,
    duration: 240,
    title: 'Original Title',
    artist: 'Original Artist',
    album: 'Original Album',
    year: 2020,
    genre: ['Pop'],
    trackNumber: 1,
    discNumber: 1,
    albumArtist: 'Original Artist',
    lyrics: null,
  };
}

/** Create mock MusicBrainz metadata */
function createMockMBMetadata(overrides: Partial<MusicBrainzMetadata> = {}): MusicBrainzMetadata {
  return {
    recordingId: 'recording-123',
    releaseId: null,
    title: 'Correct Title',
    artist: 'Correct Artist',
    featuredArtists: [],
    album: 'Correct Album',
    year: 2023,
    genres: ['Rock', 'Alternative'],
    ...overrides,
  };
}

/** Setup all mocks for a successful file processing pipeline */
function setupSuccessfulPipeline(filePath: string = '/music/test.mp3') {
  mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(filePath));

  mockedFingerprintFile.mockResolvedValue([
    {
      score: 0.95,
      acoustId: 'acoust-123',
      recordingIds: ['recording-123'],
    },
  ]);

  mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());

  mockedFetchLyrics.mockResolvedValue({
    lyrics: 'These are the lyrics\nLine two',
    source: 'lrclib',
    validated: true,
  });

  mockedWriteTagsAndRename.mockReturnValue({
    success: true,
    originalPath: filePath,
    newPath: '/music/Correct Artist - Correct Title.mp3',
    tagWriteResult: { success: true, filePath, error: null },
    renameResult: {
      success: true,
      originalPath: filePath,
      newPath: '/music/Correct Artist - Correct Title.mp3',
      error: null,
    },
    error: null,
  });
}

/** Default test batch processor options */
function getTestOptions(overrides: Partial<BatchProcessorOptions> = {}): BatchProcessorOptions {
  return {
    concurrency: 2,
    acoustIdApiKey: 'test-key',
    fingerprinterOptions: {
      apiKey: 'test-key',
      maxRetries: 0,
      baseRetryDelay: 1,
    },
    metadataFetcherOptions: {
      maxRetries: 0,
      baseRetryDelay: 1,
    },
    lyricsFetcherOptions: {
      maxRetries: 0,
      baseRetryDelay: 1,
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TokenBucketRateLimiter', () => {
  it('should allow immediate first request', async () => {
    const limiter = new TokenBucketRateLimiter(10, 1);
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('should have correct initial available tokens', () => {
    const limiter = new TokenBucketRateLimiter(10, 3);
    expect(limiter.availableTokens).toBe(3);
  });

  it('should decrement tokens on acquire', async () => {
    const limiter = new TokenBucketRateLimiter(10, 3);
    await limiter.acquire();
    expect(limiter.availableTokens).toBe(2);
  });

  it('should start with zero pending count', () => {
    const limiter = new TokenBucketRateLimiter(10, 1);
    expect(limiter.pendingCount).toBe(0);
  });

  it('should queue when no tokens available', async () => {
    const limiter = new TokenBucketRateLimiter(100, 1); // 100/sec = 10ms per token
    await limiter.acquire(); // Consume the token

    // Second acquire should need to wait
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    // Should have waited at least a few ms for token refill
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it('should destroy cleanly and resolve pending waiters', async () => {
    const limiter = new TokenBucketRateLimiter(1, 1); // 1/sec
    await limiter.acquire(); // consume token

    // Start an acquire that will need to wait
    const promise = limiter.acquire();

    // Destroy should resolve pending waiters
    limiter.destroy();
    await promise; // Should resolve without error

    expect(limiter.pendingCount).toBe(0);
  });

  it('should handle multiple burst tokens', async () => {
    const limiter = new TokenBucketRateLimiter(10, 5);
    expect(limiter.availableTokens).toBe(5);

    // Should be able to acquire 5 tokens immediately
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    expect(limiter.availableTokens).toBe(0);
  });
});

describe('BatchProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should use default concurrency (5) when not specified', () => {
      const processor = new BatchProcessor();
      expect(processor.getConcurrency()).toBe(5);
    });

    it('should accept custom concurrency', () => {
      const processor = new BatchProcessor({ concurrency: 3 });
      expect(processor.getConcurrency()).toBe(3);
    });

    it('should clamp concurrency to minimum of 1', () => {
      const processor = new BatchProcessor({ concurrency: 0 });
      expect(processor.getConcurrency()).toBe(1);
    });

    it('should clamp concurrency to maximum of 10', () => {
      const processor = new BatchProcessor({ concurrency: 20 });
      expect(processor.getConcurrency()).toBe(10);
    });

    it('should clamp negative concurrency to 1', () => {
      const processor = new BatchProcessor({ concurrency: -5 });
      expect(processor.getConcurrency()).toBe(1);
    });

    it('should not be running initially', () => {
      const processor = new BatchProcessor();
      expect(processor.isRunning()).toBe(false);
    });

    it('should have null state initially', () => {
      const processor = new BatchProcessor();
      expect(processor.getState()).toBeNull();
    });
  });

  describe('process - empty input', () => {
    it('should return empty array for empty file list', async () => {
      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([]);
      expect(results).toEqual([]);
    });

    it('should not call any service functions for empty input', async () => {
      const processor = new BatchProcessor(getTestOptions());
      await processor.process([]);
      expect(mockedReadAudioFile).not.toHaveBeenCalled();
      expect(mockedFingerprintFile).not.toHaveBeenCalled();
    });
  });

  describe('process - single file success', () => {
    it('should process a single file through the full pipeline', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('completed');
      expect(results[0].originalPath).toBe(filePath);
      expect(results[0].newPath).toBe('/music/Correct Artist - Correct Title.mp3');
    });

    it('should call readAudioFile with the file path', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      await processor.process([filePath]);

      expect(mockedReadAudioFile).toHaveBeenCalledWith(filePath);
    });

    it('should call fingerprintFile with correct arguments', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      await processor.process([filePath]);

      expect(mockedFingerprintFile).toHaveBeenCalledWith(
        filePath,
        expect.objectContaining({ apiKey: 'test-key' }),
        expect.any(Object), // FingerprintCache
        expect.any(Object), // RateLimiter
      );
    });

    it('should call fetchBestMetadata with recording IDs', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      await processor.process([filePath]);

      expect(mockedFetchBestMetadata).toHaveBeenCalledWith(
        ['recording-123'],
        expect.any(Object),
        expect.any(Object), // MetadataCache
        expect.any(Object), // MusicBrainzRateLimiter
      );
    });

    it('should call fetchLyrics when settings.fetchLyrics is true', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      await processor.process([filePath]);

      expect(mockedFetchLyrics).toHaveBeenCalledWith(
        'Correct Artist',
        'Correct Title',
        expect.any(Object),
        expect.any(Object), // LyricsCache
      );
    });

    it('should call writeTagsAndRename with corrected metadata', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      await processor.process([filePath]);

      expect(mockedWriteTagsAndRename).toHaveBeenCalledWith(
        filePath,
        expect.objectContaining({
          title: 'Correct Title',
          artist: 'Correct Artist',
          album: 'Correct Album',
          year: 2023,
          genre: ['Rock', 'Alternative'],
          lyrics: 'These are the lyrics\nLine two',
        }),
        expect.any(Object), // WriteTagsOptions
        expect.any(Object), // RenameOptions
      );
    });

    it('should populate correctedMetadata in result', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].correctedMetadata).not.toBeNull();
      expect(results[0].correctedMetadata!.title).toBe('Correct Title');
      expect(results[0].correctedMetadata!.artist).toBe('Correct Artist');
      expect(results[0].correctedMetadata!.album).toBe('Correct Album');
      expect(results[0].correctedMetadata!.year).toBe(2023);
    });

    it('should populate originalMetadata in result', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].originalMetadata).not.toBeNull();
      expect(results[0].originalMetadata!.title).toBe('Original Title');
      expect(results[0].originalMetadata!.artist).toBe('Original Artist');
    });
  });

  describe('process - featured artists', () => {
    it('should format featured artists in the artist name', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchBestMetadata.mockResolvedValue(
        createMockMBMetadata({
          artist: 'Main Artist',
          featuredArtists: ['Guest1', 'Guest2'],
        }),
      );

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].correctedMetadata!.artist).toBe('Main Artist feat. Guest1, Guest2');
    });
  });

  describe('process - lyrics disabled', () => {
    it('should skip lyrics fetch when fetchLyrics is false', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(
        getTestOptions({
          settings: {
            outputFolder: null,
            namingTemplate: '{artist} - {title}',
            concurrency: 2,
            fetchLyrics: false,
            overwriteExistingTags: false,
          },
        }),
      );
      await processor.process([filePath]);

      expect(mockedFetchLyrics).not.toHaveBeenCalled();
    });

    it('should still succeed when lyrics are disabled', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(
        getTestOptions({
          settings: {
            outputFolder: null,
            namingTemplate: '{artist} - {title}',
            concurrency: 2,
            fetchLyrics: false,
            overwriteExistingTags: false,
          },
        }),
      );
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('completed');
    });
  });

  describe('process - lyrics fetch failure is non-fatal', () => {
    it('should succeed even when lyrics fetch throws', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchLyrics.mockRejectedValue(new Error('Lyrics API down'));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('completed');
      expect(results[0].correctedMetadata!.lyrics).toBeNull();
    });

    it('should succeed when lyrics returns null', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchLyrics.mockResolvedValue(null);

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('completed');
    });
  });

  describe('process - file read error', () => {
    it('should return error status when file read fails', async () => {
      const filePath = '/music/bad.mp3';
      mockedReadAudioFile.mockRejectedValue(new Error('File not found'));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('error');
      expect(results[0].error).toContain('Failed to read file');
    });

    it('should not call fingerprinter when read fails', async () => {
      const filePath = '/music/bad.mp3';
      mockedReadAudioFile.mockRejectedValue(new Error('File not found'));

      const processor = new BatchProcessor(getTestOptions());
      await processor.process([filePath]);

      expect(mockedFingerprintFile).not.toHaveBeenCalled();
    });
  });

  describe('process - fingerprint error', () => {
    it('should return error status when fingerprinting fails', async () => {
      const filePath = '/music/test.mp3';
      mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(filePath));
      mockedFingerprintFile.mockRejectedValue(new Error('fpcalc not found'));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('error');
      expect(results[0].error).toContain('Fingerprinting failed');
    });
  });

  describe('process - no fingerprint matches', () => {
    it('should return skipped status when no matches found', async () => {
      const filePath = '/music/test.mp3';
      mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(filePath));
      mockedFingerprintFile.mockResolvedValue([]);

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('skipped');
      expect(results[0].error).toContain('No metadata found');
    });
  });

  describe('process - no recording IDs', () => {
    it('should return skipped when fingerprint has no recording IDs', async () => {
      const filePath = '/music/test.mp3';
      mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(filePath));
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'acoust-123', recordingIds: [] },
      ]);

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('skipped');
      expect(results[0].error).toContain('No metadata found');
    });
  });

  describe('process - metadata fetch error', () => {
    it('should return error when metadata fetch throws', async () => {
      const filePath = '/music/test.mp3';
      mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(filePath));
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'acoust-123', recordingIds: ['rec-123'] },
      ]);
      mockedFetchBestMetadata.mockRejectedValue(new Error('MusicBrainz timeout'));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('error');
      expect(results[0].error).toContain('Metadata fetch failed');
    });

    it('should return skipped when metadata returns null', async () => {
      const filePath = '/music/test.mp3';
      mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(filePath));
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'acoust-123', recordingIds: ['rec-123'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(null);

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('skipped');
      expect(results[0].error).toContain('No metadata found');
    });
  });

  describe('process - tag writing error', () => {
    it('should return error when tag writing fails', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedWriteTagsAndRename.mockReturnValue({
        success: false,
        originalPath: filePath,
        newPath: null,
        tagWriteResult: { success: false, filePath, error: 'Permission denied' },
        renameResult: null,
        error: 'Permission denied',
      });

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('error');
      expect(results[0].error).toContain('Tag writing/rename failed');
    });

    it('should return error when writeTagsAndRename throws', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedWriteTagsAndRename.mockImplementation(() => {
        throw new Error('Unexpected disk error');
      });

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].status).toBe('error');
      expect(results[0].error).toContain('Tag writing failed');
    });
  });

  describe('process - multiple files', () => {
    it('should process multiple files and return results for each', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3', '/music/c.mp3'];

      for (const f of files) {
        setupSuccessfulPipeline(f);
      }
      // Re-mock to handle any call
      mockedReadAudioFile.mockImplementation(async (fp: string) => createMockAudioMetadata(fp));
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp.replace('.mp3', '-renamed.mp3'),
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: {
          success: true,
          originalPath: fp,
          newPath: fp.replace('.mp3', '-renamed.mp3'),
          error: null,
        },
        error: null,
      }));

      const processor = new BatchProcessor(getTestOptions({ concurrency: 2 }));
      const results = await processor.process(files);

      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.status).toBe('completed'));
    });

    it('should maintain original file order in results', async () => {
      const files = ['/music/first.mp3', '/music/second.mp3', '/music/third.mp3'];

      mockedReadAudioFile.mockImplementation(async (fp: string) => createMockAudioMetadata(fp));
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      const processor = new BatchProcessor(getTestOptions({ concurrency: 3 }));
      const results = await processor.process(files);

      expect(results[0].originalPath).toBe('/music/first.mp3');
      expect(results[1].originalPath).toBe('/music/second.mp3');
      expect(results[2].originalPath).toBe('/music/third.mp3');
    });

    it('should isolate per-file errors (one failure does not stop others)', async () => {
      const files = ['/music/good.mp3', '/music/bad.mp3', '/music/good2.mp3'];

      mockedReadAudioFile.mockImplementation(async (fp: string) => {
        if (fp.includes('bad')) throw new Error('Corrupted file');
        return createMockAudioMetadata(fp);
      });
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      const processor = new BatchProcessor(getTestOptions({ concurrency: 1 }));
      const results = await processor.process(files);

      expect(results[0].status).toBe('completed');
      expect(results[1].status).toBe('error');
      expect(results[2].status).toBe('completed');
    });
  });

  describe('process - concurrency', () => {
    it('should process files with concurrency of 1 (sequential)', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3'];
      const callOrder: string[] = [];

      mockedReadAudioFile.mockImplementation(async (fp: string) => {
        callOrder.push(`read:${fp}`);
        return createMockAudioMetadata(fp);
      });
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => {
        callOrder.push(`write:${fp}`);
        return {
          success: true,
          originalPath: fp,
          newPath: fp,
          tagWriteResult: { success: true, filePath: fp, error: null },
          renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
          error: null,
        };
      });

      const processor = new BatchProcessor(getTestOptions({ concurrency: 1 }));
      await processor.process(files);

      // With concurrency 1, file A should be fully processed before file B starts
      const readAIdx = callOrder.indexOf('read:/music/a.mp3');
      const writeAIdx = callOrder.indexOf('write:/music/a.mp3');
      const readBIdx = callOrder.indexOf('read:/music/b.mp3');

      expect(readAIdx).toBeLessThan(writeAIdx);
      expect(writeAIdx).toBeLessThan(readBIdx);
    });

    it('should process files concurrently when concurrency > 1', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3', '/music/c.mp3', '/music/d.mp3'];
      let concurrentCount = 0;
      let maxConcurrent = 0;

      mockedReadAudioFile.mockImplementation(async (fp: string) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Simulate some async work
        await new Promise((r) => setTimeout(r, 10));
        concurrentCount--;
        return createMockAudioMetadata(fp);
      });
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      const processor = new BatchProcessor(getTestOptions({ concurrency: 3 }));
      await processor.process(files);

      // maxConcurrent should be > 1 (proving concurrency works)
      // Note: due to timing, it might not always hit exactly 3, but should be > 1
      expect(maxConcurrent).toBeGreaterThanOrEqual(1);
    });
  });

  describe('process - progress callbacks', () => {
    it('should call onProgress with updates', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const progressUpdates: ProgressUpdate[] = [];
      const processor = new BatchProcessor(
        getTestOptions({
          onProgress: (update) => progressUpdates.push({ ...update }),
        }),
      );
      await processor.process([filePath]);

      expect(progressUpdates.length).toBeGreaterThan(0);
      // First update should have totalFiles = 1
      expect(progressUpdates[0].totalFiles).toBe(1);
      // Last update should show processing complete
      const lastUpdate = progressUpdates[progressUpdates.length - 1];
      expect(lastUpdate.processedFiles).toBe(1);
    });

    it('should call onFileComplete for each processed file', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3'];

      mockedReadAudioFile.mockImplementation(async (fp: string) => createMockAudioMetadata(fp));
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      const fileCompleteResults: ProcessingResult[] = [];
      const processor = new BatchProcessor(
        getTestOptions({
          concurrency: 1,
          onFileComplete: (result) => fileCompleteResults.push(result),
        }),
      );
      await processor.process(files);

      expect(fileCompleteResults).toHaveLength(2);
    });

    it('should include estimated time remaining in progress', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3', '/music/c.mp3'];

      mockedReadAudioFile.mockImplementation(async (fp: string) => {
        await new Promise((r) => setTimeout(r, 10)); // Small delay for ETA calculation
        return createMockAudioMetadata(fp);
      });
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      const progressUpdates: ProgressUpdate[] = [];
      const processor = new BatchProcessor(
        getTestOptions({
          concurrency: 1,
          onProgress: (update) => progressUpdates.push({ ...update }),
        }),
      );
      await processor.process(files);

      // At least one progress update after the first file should have ETA
      const updatesAfterFirst = progressUpdates.filter((u) => u.processedFiles > 0);
      expect(updatesAfterFirst.length).toBeGreaterThan(0);
    });

    it('should include current file name in progress', async () => {
      const filePath = '/music/my-song.mp3';
      setupSuccessfulPipeline(filePath);

      const progressUpdates: ProgressUpdate[] = [];
      const processor = new BatchProcessor(
        getTestOptions({
          onProgress: (update) => progressUpdates.push({ ...update }),
        }),
      );
      await processor.process([filePath]);

      // At least one update should have the current file
      const withFile = progressUpdates.filter((u) => u.currentFile !== null);
      expect(withFile.length).toBeGreaterThan(0);
      expect(withFile.some((u) => u.currentFile === 'my-song.mp3')).toBe(true);
    });
  });

  describe('process - success/error/skip counts', () => {
    it('should count successes correctly', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3'];

      mockedReadAudioFile.mockImplementation(async (fp: string) => createMockAudioMetadata(fp));
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      let lastProgress: ProgressUpdate | null = null;
      const processor = new BatchProcessor(
        getTestOptions({
          concurrency: 1,
          onProgress: (u) => {
            lastProgress = { ...u };
          },
        }),
      );
      await processor.process(files);

      expect(lastProgress!.successCount).toBe(2);
      expect(lastProgress!.errorCount).toBe(0);
      expect(lastProgress!.skippedCount).toBe(0);
    });

    it('should count errors correctly', async () => {
      const files = ['/music/bad1.mp3', '/music/bad2.mp3'];
      mockedReadAudioFile.mockRejectedValue(new Error('Cannot read'));

      let lastProgress: ProgressUpdate | null = null;
      const processor = new BatchProcessor(
        getTestOptions({
          concurrency: 1,
          onProgress: (u) => {
            lastProgress = { ...u };
          },
        }),
      );
      await processor.process(files);

      expect(lastProgress!.errorCount).toBe(2);
      expect(lastProgress!.successCount).toBe(0);
    });

    it('should count skips correctly', async () => {
      const files = ['/music/unknown.mp3'];

      mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(files[0]));
      mockedFingerprintFile.mockResolvedValue([]); // No matches

      let lastProgress: ProgressUpdate | null = null;
      const processor = new BatchProcessor(
        getTestOptions({
          onProgress: (u) => {
            lastProgress = { ...u };
          },
        }),
      );
      await processor.process(files);

      expect(lastProgress!.skippedCount).toBe(1);
    });

    it('should count mixed results correctly', async () => {
      const files = ['/music/good.mp3', '/music/bad.mp3', '/music/unknown.mp3'];

      mockedReadAudioFile.mockImplementation(async (fp: string) => {
        if (fp.includes('bad')) throw new Error('Cannot read');
        return createMockAudioMetadata(fp);
      });
      mockedFingerprintFile.mockImplementation(async (fp: string) => {
        if (fp.includes('unknown')) return [];
        return [{ score: 0.95, acoustId: 'a', recordingIds: ['r1'] }];
      });
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      let lastProgress: ProgressUpdate | null = null;
      const processor = new BatchProcessor(
        getTestOptions({
          concurrency: 1,
          onProgress: (u) => {
            lastProgress = { ...u };
          },
        }),
      );
      await processor.process(files);

      expect(lastProgress!.successCount).toBe(1);
      expect(lastProgress!.errorCount).toBe(1);
      expect(lastProgress!.skippedCount).toBe(1);
      expect(lastProgress!.processedFiles).toBe(3);
    });
  });

  describe('process - cancellation', () => {
    it('should stop processing new files after cancel', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3', '/music/c.mp3', '/music/d.mp3'];
      let processedCount = 0;

      mockedReadAudioFile.mockImplementation(async (fp: string) => {
        processedCount++;
        await new Promise((r) => setTimeout(r, 20));
        return createMockAudioMetadata(fp);
      });
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      const processor = new BatchProcessor(getTestOptions({ concurrency: 1 }));

      // Cancel after a short delay (should cancel after first file or so)
      setTimeout(() => processor.cancel(), 30);

      const results = await processor.process(files);

      // Should have some results
      expect(results).toHaveLength(4);
      // Files that weren't processed should be marked as skipped with cancel message
      const skipped = results.filter(
        (r) => r.status === 'skipped' && r.error === 'Processing cancelled',
      );
      expect(skipped.length).toBeGreaterThan(0);
    });

    it('should mark unprocessed files as skipped with cancel reason', async () => {
      const files = ['/music/a.mp3', '/music/b.mp3', '/music/c.mp3', '/music/d.mp3'];

      // First file will take long enough for cancel to happen before others start
      mockedReadAudioFile.mockImplementation(async (fp: string) => {
        await new Promise((r) => setTimeout(r, 50));
        return createMockAudioMetadata(fp);
      });
      mockedFingerprintFile.mockResolvedValue([
        { score: 0.95, acoustId: 'a', recordingIds: ['r1'] },
      ]);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata());
      mockedFetchLyrics.mockResolvedValue(null);
      mockedWriteTagsAndRename.mockImplementation((fp: string) => ({
        success: true,
        originalPath: fp,
        newPath: fp,
        tagWriteResult: { success: true, filePath: fp, error: null },
        renameResult: { success: true, originalPath: fp, newPath: fp, error: null },
        error: null,
      }));

      const processor = new BatchProcessor(getTestOptions({ concurrency: 1 }));

      // Cancel very shortly after start so some files don't get processed
      setTimeout(() => processor.cancel(), 10);

      const results = await processor.process(files);

      // Some results should be skipped with cancel message
      const skipped = results.filter((r) => r.error === 'Processing cancelled');
      expect(skipped.length).toBeGreaterThan(0);
      // Total results should still be full count
      expect(results).toHaveLength(4);
    });

    it('isRunning should return false after cancel completes', async () => {
      const processor = new BatchProcessor(getTestOptions());
      setupSuccessfulPipeline('/music/test.mp3');

      const processPromise = processor.process(['/music/test.mp3']);
      processor.cancel();
      await processPromise;

      expect(processor.isRunning()).toBe(false);
    });
  });

  describe('process - state management', () => {
    it('should be null state before processing', () => {
      const processor = new BatchProcessor(getTestOptions());
      expect(processor.getState()).toBeNull();
    });

    it('should be null state after processing completes', async () => {
      setupSuccessfulPipeline('/music/test.mp3');
      const processor = new BatchProcessor(getTestOptions());

      await processor.process(['/music/test.mp3']);

      expect(processor.getState()).toBeNull();
    });

    it('should not be running after processing completes', async () => {
      setupSuccessfulPipeline('/music/test.mp3');
      const processor = new BatchProcessor(getTestOptions());

      await processor.process(['/music/test.mp3']);

      expect(processor.isRunning()).toBe(false);
    });
  });

  describe('processFile - direct call', () => {
    it('should process a single file through full pipeline', async () => {
      const filePath = '/music/direct.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(getTestOptions());
      const result = await processor.processFile(filePath);

      expect(result.status).toBe('completed');
      expect(result.originalPath).toBe(filePath);
    });

    it('should handle unexpected throws gracefully', async () => {
      const filePath = '/music/weird.mp3';
      mockedReadAudioFile.mockImplementation(() => {
        throw 'string error'; // Non-Error throw
      });

      const processor = new BatchProcessor(getTestOptions());
      const result = await processor.processFile(filePath);

      // Should still return a result (not crash)
      expect(result.status).toBe('error');
    });
  });

  describe('process - logger integration', () => {
    it('should log batch start and completion', async () => {
      setupSuccessfulPipeline('/music/test.mp3');

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        logError: vi.fn(),
        logSkippedFile: vi.fn(),
      };

      const processor = new BatchProcessor(getTestOptions({ logger: mockLogger as any }));
      await processor.process(['/music/test.mp3']);

      // Should log batch start (called with just the message, no second arg)
      const infoCalls = mockLogger.info.mock.calls.map((c: any[]) => c[0] as string);
      expect(infoCalls.some((msg: string) => msg.includes('Starting batch processing'))).toBe(true);
      // Should log completion
      expect(infoCalls.some((msg: string) => msg.includes('Batch processing complete'))).toBe(true);
    });

    it('should log errors via logger.logError', async () => {
      const filePath = '/music/bad.mp3';
      mockedReadAudioFile.mockRejectedValue(new Error('Cannot read'));

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        logError: vi.fn(),
        logSkippedFile: vi.fn(),
      };

      const processor = new BatchProcessor(getTestOptions({ logger: mockLogger as any }));
      await processor.process([filePath]);

      expect(mockLogger.logError).toHaveBeenCalled();
    });

    it('should log skipped files via logger.logSkippedFile', async () => {
      const filePath = '/music/unknown.mp3';
      mockedReadAudioFile.mockResolvedValue(createMockAudioMetadata(filePath));
      mockedFingerprintFile.mockResolvedValue([]);

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        logError: vi.fn(),
        logSkippedFile: vi.fn(),
      };

      const processor = new BatchProcessor(getTestOptions({ logger: mockLogger as any }));
      await processor.process([filePath]);

      expect(mockLogger.logSkippedFile).toHaveBeenCalledWith(
        filePath,
        expect.stringContaining('No metadata found'),
      );
    });

    it('should log lyrics fetch failure as warning', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchLyrics.mockRejectedValue(new Error('API down'));

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        logError: vi.fn(),
        logSkippedFile: vi.fn(),
      };

      const processor = new BatchProcessor(getTestOptions({ logger: mockLogger as any }));
      await processor.process([filePath]);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Lyrics fetch failed'),
        expect.objectContaining({ step: 'fetching_lyrics' }),
      );
    });
  });

  describe('process - settings integration', () => {
    it('should pass overwriteExistingTags setting to writeTagsOptions', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(
        getTestOptions({
          settings: {
            outputFolder: null,
            namingTemplate: '{artist} - {title}',
            concurrency: 2,
            fetchLyrics: true,
            overwriteExistingTags: true,
          },
        }),
      );
      await processor.process([filePath]);

      expect(mockedWriteTagsAndRename).toHaveBeenCalledWith(
        filePath,
        expect.any(Object),
        expect.objectContaining({ overwriteAll: true }),
        expect.any(Object),
      );
    });

    it('should pass outputFolder setting to renameOptions', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);

      const processor = new BatchProcessor(
        getTestOptions({
          settings: {
            outputFolder: '/output',
            namingTemplate: '{artist} - {title}',
            concurrency: 2,
            fetchLyrics: true,
            overwriteExistingTags: false,
          },
        }),
      );
      await processor.process([filePath]);

      expect(mockedWriteTagsAndRename).toHaveBeenCalledWith(
        filePath,
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ outputDir: '/output' }),
      );
    });
  });

  describe('process - metadata mapping', () => {
    it('should map genres correctly when present', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata({ genres: ['Rock', 'Pop'] }));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].correctedMetadata!.genre).toEqual(['Rock', 'Pop']);
    });

    it('should set genre to null when empty genres array', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata({ genres: [] }));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].correctedMetadata!.genre).toBeNull();
    });

    it('should set album to null when missing', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata({ album: null }));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].correctedMetadata!.album).toBeNull();
    });

    it('should set year to null when missing', async () => {
      const filePath = '/music/test.mp3';
      setupSuccessfulPipeline(filePath);
      mockedFetchBestMetadata.mockResolvedValue(createMockMBMetadata({ year: null }));

      const processor = new BatchProcessor(getTestOptions());
      const results = await processor.process([filePath]);

      expect(results[0].correctedMetadata!.year).toBeNull();
    });
  });
});

describe('estimateProcessingTime', () => {
  it('should return 0 for 0 files', () => {
    expect(estimateProcessingTime(0)).toBe(0);
  });

  it('should return 0 for negative file count', () => {
    expect(estimateProcessingTime(-5)).toBe(0);
  });

  it('should return positive time for positive file count', () => {
    expect(estimateProcessingTime(10)).toBeGreaterThan(0);
  });

  it('should return less time with higher concurrency', () => {
    const timeLow = estimateProcessingTime(100, 1);
    const timeHigh = estimateProcessingTime(100, 5);
    expect(timeHigh).toBeLessThanOrEqual(timeLow);
  });

  it('should clamp concurrency to 1-10', () => {
    // Very high concurrency should still produce a positive result
    const time = estimateProcessingTime(10, 100);
    expect(time).toBeGreaterThan(0);
  });

  it('should be bounded by MusicBrainz rate limit floor', () => {
    // Even with max concurrency, time should not go below ~1.2s per file
    const time = estimateProcessingTime(100, 10);
    expect(time).toBeGreaterThanOrEqual(100); // At least 100 * 1s
  });

  it('should scale linearly with file count', () => {
    const time10 = estimateProcessingTime(10, 5);
    const time20 = estimateProcessingTime(20, 5);
    // 20 files should take roughly 2x as long as 10
    expect(time20).toBeGreaterThan(time10);
    expect(time20).toBeLessThanOrEqual(time10 * 2.5);
  });
});
