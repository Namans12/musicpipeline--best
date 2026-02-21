/* eslint-disable @typescript-eslint/unbound-method */
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
  AcoustIdResponse,
  FingerprinterOptions,
  FingerprintCache,
  RateLimiter,
  findFpcalcPath,
  runFpcalc,
  queryAcoustId,
  fingerprintFile,
  fingerprintMultipleFiles,
} from '../../../src/main/services/fingerprinter';
import type { FingerprintResult } from '../../../src/shared/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

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

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'fixtures');

function fixture(filename: string): string {
  return path.join(FIXTURES_DIR, filename);
}

/** Default test options */
const DEFAULT_OPTIONS: FingerprinterOptions = {
  apiKey: 'test-api-key',
  fpcalcPath: '/usr/bin/fpcalc',
  maxRetries: 2,
  baseRetryDelay: 10, // Very short for tests
  minScore: 0.0,
  fpcalcTimeout: 5000,
};

/** Get the mocked execFile function */
function getMockedExecFile(): ReturnType<typeof vi.mocked<typeof childProcess.execFile>> {
  return vi.mocked(childProcess.execFile);
}

/** Get the mocked axios.get function */
function getMockedAxiosGet(): ReturnType<typeof vi.mocked<typeof axios.get>> {
  return vi.mocked(axios.get);
}

/** Mock a successful fpcalc execution */
function mockFpcalcSuccess(
  duration: number = 240,
  fingerprint: string = 'AQAA_mock_fingerprint',
): void {
  getMockedExecFile().mockImplementation(((
    _file: string,
    _args: unknown,
    _options: unknown,
    callback: unknown,
  ) => {
    const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
    cb(null, JSON.stringify({ duration, fingerprint }), '');
  }) as unknown as typeof childProcess.execFile);
}

/** Mock a failed fpcalc execution */
function mockFpcalcError(errorMessage: string, code?: string): void {
  getMockedExecFile().mockImplementation(((
    _file: string,
    _args: unknown,
    _options: unknown,
    callback: unknown,
  ) => {
    const error = new Error(errorMessage) as NodeJS.ErrnoException;
    if (code) {
      error.code = code;
    }
    const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
    cb(error, '', '');
  }) as unknown as typeof childProcess.execFile);
}

/** Create a mock AcoustID API response */
function createAcoustIdResponse(
  results: Array<{ id: string; score: number; recordings?: Array<{ id: string }> }>,
): AcoustIdResponse {
  return {
    status: 'ok',
    results: results.map((r) => ({
      id: r.id,
      score: r.score,
      recordings: r.recordings,
    })),
  };
}

/** Mock a successful AcoustID API response */
function mockAcoustIdSuccess(
  results: Array<{ id: string; score: number; recordings?: Array<{ id: string }> }>,
): void {
  getMockedAxiosGet().mockResolvedValue({
    data: createAcoustIdResponse(results),
    status: 200,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('fingerprinter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── FingerprintCache ──────────────────────────────────────────────────

  describe('FingerprintCache', () => {
    let cache: FingerprintCache;

    beforeEach(() => {
      cache = new FingerprintCache();
    });

    it('should start empty', () => {
      expect(cache.size).toBe(0);
      expect(cache.has('/some/file.mp3')).toBe(false);
    });

    it('should store and retrieve results', () => {
      const results: FingerprintResult[] = [
        { score: 0.95, acoustId: 'abc-123', recordingIds: ['rec-1', 'rec-2'] },
      ];

      cache.set('/music/song.mp3', results);

      expect(cache.has('/music/song.mp3')).toBe(true);
      expect(cache.get('/music/song.mp3')).toEqual(results);
      expect(cache.size).toBe(1);
    });

    it('should resolve file paths to absolute paths', () => {
      const results: FingerprintResult[] = [{ score: 0.9, acoustId: 'xyz', recordingIds: [] }];

      // Store with one path format, retrieve with resolved
      const absolutePath = path.resolve('relative/path/song.mp3');
      cache.set('relative/path/song.mp3', results);

      expect(cache.has(absolutePath)).toBe(true);
      expect(cache.get(absolutePath)).toEqual(results);
    });

    it('should return undefined for missing entries', () => {
      expect(cache.get('/nonexistent/file.mp3')).toBeUndefined();
    });

    it('should delete entries', () => {
      const results: FingerprintResult[] = [{ score: 0.8, acoustId: 'test', recordingIds: [] }];

      cache.set('/music/song.mp3', results);
      expect(cache.has('/music/song.mp3')).toBe(true);

      const deleted = cache.delete('/music/song.mp3');
      expect(deleted).toBe(true);
      expect(cache.has('/music/song.mp3')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should return false when deleting non-existent entry', () => {
      expect(cache.delete('/nonexistent.mp3')).toBe(false);
    });

    it('should clear all entries', () => {
      cache.set('/song1.mp3', []);
      cache.set('/song2.mp3', []);
      cache.set('/song3.mp3', []);

      expect(cache.size).toBe(3);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.has('/song1.mp3')).toBe(false);
    });

    it('should overwrite existing entries', () => {
      const results1: FingerprintResult[] = [{ score: 0.5, acoustId: 'old', recordingIds: [] }];
      const results2: FingerprintResult[] = [
        { score: 0.95, acoustId: 'new', recordingIds: ['rec-1'] },
      ];

      cache.set('/song.mp3', results1);
      cache.set('/song.mp3', results2);

      expect(cache.size).toBe(1);
      expect(cache.get('/song.mp3')).toEqual(results2);
    });
  });

  // ─── RateLimiter ───────────────────────────────────────────────────────

  describe('RateLimiter', () => {
    it('should allow the first request immediately', async () => {
      const limiter = new RateLimiter(100);
      const start = Date.now();
      await limiter.waitForSlot();
      const elapsed = Date.now() - start;

      // Should complete very quickly (first call, no wait)
      expect(elapsed).toBeLessThan(50);
    });

    it('should enforce minimum interval between requests', async () => {
      const intervalMs = 100;
      const limiter = new RateLimiter(intervalMs);

      await limiter.waitForSlot(); // First request (immediate)
      const start = Date.now();
      await limiter.waitForSlot(); // Second request (should wait)
      const elapsed = Date.now() - start;

      // Should wait at least close to the interval
      expect(elapsed).toBeGreaterThanOrEqual(intervalMs - 20); // Allow 20ms tolerance
    });

    it('should allow request after interval has passed', async () => {
      const intervalMs = 50;
      const limiter = new RateLimiter(intervalMs);

      await limiter.waitForSlot();
      // Wait longer than the interval
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs + 20));

      const start = Date.now();
      await limiter.waitForSlot();
      const elapsed = Date.now() - start;

      // Should be near-immediate since enough time has passed
      expect(elapsed).toBeLessThan(30);
    });

    it('should serialise concurrent callers so they fire one at a time', async () => {
      const intervalMs = 50;
      const limiter = new RateLimiter(intervalMs);
      const timestamps: number[] = [];

      // Fire 4 concurrent calls at once
      await Promise.all(
        [0, 1, 2, 3].map(async () => {
          await limiter.waitForSlot();
          timestamps.push(Date.now());
        }),
      );

      // Sort timestamps (Promise.all resolves in undefined order)
      timestamps.sort((a, b) => a - b);

      // Each consecutive release should be separated by at least (intervalMs - 20ms tolerance)
      for (let i = 1; i < timestamps.length; i++) {
        const gap = timestamps[i] - timestamps[i - 1];
        expect(gap).toBeGreaterThanOrEqual(intervalMs - 20);
      }
    });
  });

  // ─── findFpcalcPath ────────────────────────────────────────────────────

  describe('findFpcalcPath', () => {
    it('should return a string', () => {
      const result = findFpcalcPath();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return either a valid path to fpcalc or fallback to "fpcalc"', () => {
      const result = findFpcalcPath();
      // Either returns 'fpcalc' (fallback to PATH) or a path containing 'fpcalc'
      expect(result.toLowerCase()).toContain('fpcalc');
    });
  });

  // ─── runFpcalc ─────────────────────────────────────────────────────────

  describe('runFpcalc', () => {
    it('should return fingerprint and duration on success', async () => {
      const expectedDuration = 234.5;
      const expectedFingerprint = 'AQAAtest123fingerprint';
      mockFpcalcSuccess(expectedDuration, expectedFingerprint);

      const result = await runFpcalc(fixture('silence.mp3'), '/usr/bin/fpcalc');

      expect(result.duration).toBe(expectedDuration);
      expect(result.fingerprint).toBe(expectedFingerprint);
    });

    it('should call execFile with correct arguments', async () => {
      mockFpcalcSuccess();

      await runFpcalc(fixture('silence.mp3'), '/usr/bin/fpcalc', 5000);

      const mockedExecFile = getMockedExecFile();
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      const callArgs = mockedExecFile.mock.calls[0] as unknown as [
        string,
        string[],
        { timeout: number },
      ];
      expect(callArgs[0]).toBe('/usr/bin/fpcalc');
      expect(callArgs[1]).toEqual(['-json', fixture('silence.mp3')]);
      expect(callArgs[2].timeout).toBe(5000);
    });

    it('should throw for non-existent files', async () => {
      await expect(runFpcalc('/nonexistent/path/song.mp3', '/usr/bin/fpcalc')).rejects.toThrow(
        'File not found',
      );
    });

    it('should throw ENOENT error when fpcalc binary is not found', async () => {
      mockFpcalcError('spawn fpcalc ENOENT', 'ENOENT');

      await expect(runFpcalc(fixture('silence.mp3'), '/nonexistent/fpcalc')).rejects.toThrow(
        'fpcalc not found',
      );
    });

    it('should include Chromaprint download link in ENOENT error', async () => {
      mockFpcalcError('spawn fpcalc ENOENT', 'ENOENT');

      await expect(runFpcalc(fixture('silence.mp3'), '/bad/path/fpcalc')).rejects.toThrow(
        'https://acoustid.org/chromaprint',
      );
    });

    it('should throw descriptive error for other fpcalc failures', async () => {
      mockFpcalcError('segfault');

      await expect(runFpcalc(fixture('silence.mp3'), '/usr/bin/fpcalc')).rejects.toThrow(
        'fpcalc failed',
      );
    });

    it('should throw when fpcalc returns invalid JSON', async () => {
      getMockedExecFile().mockImplementation(((
        _file: string,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ) => {
        const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
        cb(null, 'not valid json', '');
      }) as unknown as typeof childProcess.execFile);

      await expect(runFpcalc(fixture('silence.mp3'), '/usr/bin/fpcalc')).rejects.toThrow(
        'Failed to parse fpcalc output',
      );
    });

    it('should throw when fpcalc returns JSON without fingerprint', async () => {
      getMockedExecFile().mockImplementation(((
        _file: string,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ) => {
        const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
        cb(null, JSON.stringify({ duration: 100 }), '');
      }) as unknown as typeof childProcess.execFile);

      await expect(runFpcalc(fixture('silence.mp3'), '/usr/bin/fpcalc')).rejects.toThrow(
        'invalid output',
      );
    });

    it('should throw when fpcalc returns JSON without valid duration', async () => {
      getMockedExecFile().mockImplementation(((
        _file: string,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ) => {
        const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
        cb(null, JSON.stringify({ fingerprint: 'AQAA' }), '');
      }) as unknown as typeof childProcess.execFile);

      await expect(runFpcalc(fixture('silence.mp3'), '/usr/bin/fpcalc')).rejects.toThrow(
        'invalid output',
      );
    });
  });

  // ─── queryAcoustId ─────────────────────────────────────────────────────

  describe('queryAcoustId', () => {
    let rateLimiter: RateLimiter;

    beforeEach(() => {
      // Use a very short interval for tests
      rateLimiter = new RateLimiter(1);
    });

    it('should call the AcoustID API with correct parameters', async () => {
      mockAcoustIdSuccess([]);

      await queryAcoustId('AQAA_fingerprint', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(getMockedAxiosGet()).toHaveBeenCalledWith(
        'https://api.acoustid.org/v2/lookup',
        expect.objectContaining({
          params: {
            client: 'test-api-key',
            fingerprint: 'AQAA_fingerprint',
            duration: 240,
            meta: 'recordings',
            format: 'json',
          },
        }),
      );
    });

    it('should round duration to nearest integer', async () => {
      mockAcoustIdSuccess([]);

      await queryAcoustId('fp', 240.7, DEFAULT_OPTIONS, rateLimiter);

      expect(getMockedAxiosGet()).toHaveBeenCalledWith(
        expect.any(String) as string,
        expect.objectContaining({
          params: expect.objectContaining({
            duration: 241,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('should use custom API base URL when provided', async () => {
      const options: FingerprinterOptions = {
        ...DEFAULT_OPTIONS,
        apiBaseUrl: 'http://localhost:3000/lookup',
      };
      mockAcoustIdSuccess([]);

      await queryAcoustId('fp', 240, options, rateLimiter);

      expect(getMockedAxiosGet()).toHaveBeenCalledWith(
        'http://localhost:3000/lookup',
        expect.any(Object) as Record<string, unknown>,
      );
    });

    it('should return empty array when no results', async () => {
      mockAcoustIdSuccess([]);

      const results = await queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(results).toEqual([]);
    });

    it('should map AcoustID results to FingerprintResult array', async () => {
      mockAcoustIdSuccess([
        {
          id: 'acoust-1',
          score: 0.95,
          recordings: [{ id: 'rec-1' }, { id: 'rec-2' }],
        },
        {
          id: 'acoust-2',
          score: 0.65,
          recordings: [{ id: 'rec-3' }],
        },
      ]);

      const results = await queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        score: 0.95,
        acoustId: 'acoust-1',
        recordingIds: ['rec-1', 'rec-2'],
      });
      expect(results[1]).toEqual({
        score: 0.65,
        acoustId: 'acoust-2',
        recordingIds: ['rec-3'],
      });
    });

    it('should sort results by score descending', async () => {
      mockAcoustIdSuccess([
        { id: 'low', score: 0.3, recordings: [] },
        { id: 'high', score: 0.99, recordings: [] },
        { id: 'mid', score: 0.7, recordings: [] },
      ]);

      const results = await queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(results[0].score).toBe(0.99);
      expect(results[1].score).toBe(0.7);
      expect(results[2].score).toBe(0.3);
    });

    it('should handle results without recordings field', async () => {
      mockAcoustIdSuccess([{ id: 'no-recordings', score: 0.8 }]);

      const results = await queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(results).toHaveLength(1);
      expect(results[0].recordingIds).toEqual([]);
    });

    it('should filter results below minScore', async () => {
      const options: FingerprinterOptions = {
        ...DEFAULT_OPTIONS,
        minScore: 0.9,
      };

      mockAcoustIdSuccess([
        { id: 'high', score: 0.95, recordings: [{ id: 'rec-1' }] },
        { id: 'low', score: 0.5, recordings: [{ id: 'rec-2' }] },
        { id: 'exact', score: 0.9, recordings: [{ id: 'rec-3' }] },
      ]);

      const results = await queryAcoustId('fp', 240, options, rateLimiter);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.score >= 0.9)).toBe(true);
    });

    it('should throw when API returns non-ok status', async () => {
      getMockedAxiosGet().mockResolvedValue({
        data: { status: 'error', results: [] },
        status: 200,
      });

      await expect(queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter)).rejects.toThrow(
        'AcoustID API returned status: error',
      );
    });

    it('should retry on server errors (5xx)', async () => {
      const axiosError = new Error('Internal Server Error') as Error & {
        isAxiosError: boolean;
        response: { status: number; data: unknown };
      };
      axiosError.isAxiosError = true;
      axiosError.response = { status: 500, data: {} };

      getMockedAxiosGet()
        .mockRejectedValueOnce(axiosError)
        .mockRejectedValueOnce(axiosError)
        .mockResolvedValueOnce({
          data: createAcoustIdResponse([
            { id: 'success', score: 0.9, recordings: [{ id: 'rec-1' }] },
          ]),
          status: 200,
        });

      const results = await queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(results).toHaveLength(1);
      expect(results[0].acoustId).toBe('success');
      // Should have been called 3 times (2 failures + 1 success)
      expect(getMockedAxiosGet()).toHaveBeenCalledTimes(3);
    });

    it('should retry on 429 rate limit errors', async () => {
      const rateLimitError = new Error('Too Many Requests') as Error & {
        isAxiosError: boolean;
        response: { status: number; data: unknown };
      };
      rateLimitError.isAxiosError = true;
      rateLimitError.response = { status: 429, data: {} };

      getMockedAxiosGet()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: createAcoustIdResponse([{ id: 'ok', score: 0.85 }]),
          status: 200,
        });

      const results = await queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(results).toHaveLength(1);
      expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on 4xx client errors (except 429)', async () => {
      const clientError = new Error('Forbidden') as Error & {
        isAxiosError: boolean;
        response: { status: number; data: { error?: { message: string } } };
      };
      clientError.isAxiosError = true;
      clientError.response = { status: 403, data: { error: { message: 'Invalid API key' } } };

      getMockedAxiosGet().mockRejectedValueOnce(clientError);

      await expect(queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter)).rejects.toThrow(
        'AcoustID API error (403)',
      );

      // Should NOT retry - only called once
      expect(getMockedAxiosGet()).toHaveBeenCalledTimes(1);
    });

    it('should throw after exhausting all retries', async () => {
      const serverError = new Error('Server Error') as Error & {
        isAxiosError: boolean;
        response: { status: number; data: unknown };
      };
      serverError.isAxiosError = true;
      serverError.response = { status: 500, data: {} };

      getMockedAxiosGet().mockRejectedValue(serverError);

      const options: FingerprinterOptions = {
        ...DEFAULT_OPTIONS,
        maxRetries: 2,
      };

      await expect(queryAcoustId('fp', 240, options, rateLimiter)).rejects.toThrow(
        'failed after 3 attempts',
      );

      // 1 initial + 2 retries = 3 attempts
      expect(getMockedAxiosGet()).toHaveBeenCalledTimes(3);
    });

    it('should retry on network errors', async () => {
      const networkError = new Error('ECONNREFUSED') as Error & {
        isAxiosError: boolean;
        response: undefined;
      };
      networkError.isAxiosError = true;
      networkError.response = undefined;

      getMockedAxiosGet()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({
          data: createAcoustIdResponse([]),
          status: 200,
        });

      const results = await queryAcoustId('fp', 240, DEFAULT_OPTIONS, rateLimiter);

      expect(results).toEqual([]);
      expect(getMockedAxiosGet()).toHaveBeenCalledTimes(2);
    });
  });

  // ─── fingerprintFile ───────────────────────────────────────────────────

  describe('fingerprintFile', () => {
    let cache: FingerprintCache;
    let rateLimiter: RateLimiter;

    beforeEach(() => {
      cache = new FingerprintCache();
      rateLimiter = new RateLimiter(1); // Very short interval for tests
    });

    it('should fingerprint a file and return results', async () => {
      mockFpcalcSuccess(240, 'AQAA_real_fingerprint');
      mockAcoustIdSuccess([
        {
          id: 'acoust-1',
          score: 0.97,
          recordings: [{ id: 'mb-recording-1' }],
        },
      ]);

      const results = await fingerprintFile(
        fixture('silence.mp3'),
        DEFAULT_OPTIONS,
        cache,
        rateLimiter,
      );

      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.97);
      expect(results[0].acoustId).toBe('acoust-1');
      expect(results[0].recordingIds).toEqual(['mb-recording-1']);
    });

    it('should cache results after first call', async () => {
      mockFpcalcSuccess(240, 'AQAA_fingerprint');
      mockAcoustIdSuccess([{ id: 'id-1', score: 0.9, recordings: [{ id: 'rec-1' }] }]);

      // First call - should hit API
      await fingerprintFile(fixture('silence.mp3'), DEFAULT_OPTIONS, cache, rateLimiter);
      expect(cache.has(path.resolve(fixture('silence.mp3')))).toBe(true);

      // Reset mocks to verify cache is used
      getMockedExecFile().mockClear();
      getMockedAxiosGet().mockClear();

      // Second call - should use cache
      const results = await fingerprintFile(
        fixture('silence.mp3'),
        DEFAULT_OPTIONS,
        cache,
        rateLimiter,
      );

      expect(results).toHaveLength(1);
      // Should NOT have called fpcalc or API again
      expect(getMockedExecFile()).not.toHaveBeenCalled();
      expect(getMockedAxiosGet()).not.toHaveBeenCalled();
    });

    it('should work without cache', async () => {
      mockFpcalcSuccess(300, 'AQAA_nocache');
      mockAcoustIdSuccess([{ id: 'nc-1', score: 0.85, recordings: [] }]);

      const results = await fingerprintFile(
        fixture('silence.mp3'),
        DEFAULT_OPTIONS,
        undefined, // No cache
        rateLimiter,
      );

      expect(results).toHaveLength(1);
    });

    it('should work without providing rateLimiter (uses default)', async () => {
      mockFpcalcSuccess(180, 'AQAA_default_rl');
      mockAcoustIdSuccess([{ id: 'def-1', score: 0.75, recordings: [] }]);

      const results = await fingerprintFile(
        fixture('silence.mp3'),
        DEFAULT_OPTIONS,
        cache,
        // No rateLimiter
      );

      expect(results).toHaveLength(1);
    });

    it('should throw when fpcalc fails', async () => {
      mockFpcalcError('fpcalc crashed', 'ENOENT');

      await expect(
        fingerprintFile(fixture('silence.mp3'), DEFAULT_OPTIONS, cache, rateLimiter),
      ).rejects.toThrow('fpcalc not found');
    });

    it('should throw when API fails after retries', async () => {
      mockFpcalcSuccess(240, 'AQAA_fp');

      const serverError = new Error('Server Error') as Error & {
        isAxiosError: boolean;
        response: { status: number; data: unknown };
      };
      serverError.isAxiosError = true;
      serverError.response = { status: 500, data: {} };
      getMockedAxiosGet().mockRejectedValue(serverError);

      await expect(
        fingerprintFile(fixture('silence.mp3'), DEFAULT_OPTIONS, cache, rateLimiter),
      ).rejects.toThrow('failed after');
    });

    it('should not cache failed results', async () => {
      mockFpcalcError('crash');

      try {
        await fingerprintFile(fixture('silence.mp3'), DEFAULT_OPTIONS, cache, rateLimiter);
      } catch {
        // Expected
      }

      expect(cache.has(path.resolve(fixture('silence.mp3')))).toBe(false);
    });

    it('should return results sorted by score descending', async () => {
      mockFpcalcSuccess(200, 'AQAA_multi');
      mockAcoustIdSuccess([
        { id: 'low', score: 0.3, recordings: [] },
        { id: 'high', score: 0.99, recordings: [{ id: 'rec-a' }] },
        { id: 'mid', score: 0.7, recordings: [{ id: 'rec-b' }] },
      ]);

      const results = await fingerprintFile(
        fixture('silence.mp3'),
        DEFAULT_OPTIONS,
        cache,
        rateLimiter,
      );

      expect(results[0].score).toBe(0.99);
      expect(results[1].score).toBe(0.7);
      expect(results[2].score).toBe(0.3);
    });
  });

  // ─── fingerprintMultipleFiles ──────────────────────────────────────────

  describe('fingerprintMultipleFiles', () => {
    it('should process multiple files and return results for each', async () => {
      mockFpcalcSuccess(240, 'AQAA_batch');
      mockAcoustIdSuccess([{ id: 'batch-1', score: 0.92, recordings: [{ id: 'rec-b1' }] }]);

      const results = await fingerprintMultipleFiles(
        [fixture('silence.mp3'), fixture('tagged.mp3')],
        DEFAULT_OPTIONS,
      );

      expect(results).toHaveLength(2);
      results.forEach((result) => {
        expect(result.results).not.toBeNull();
        expect(result.error).toBeNull();
      });
    });

    it('should include file path in each result', async () => {
      mockFpcalcSuccess(100, 'AQAA_paths');
      mockAcoustIdSuccess([]);

      const filePaths = [fixture('silence.mp3'), fixture('tagged.mp3')];
      const results = await fingerprintMultipleFiles(filePaths, DEFAULT_OPTIONS);

      expect(results[0].filePath).toBe(filePaths[0]);
      expect(results[1].filePath).toBe(filePaths[1]);
    });

    it('should handle individual file failures without stopping', async () => {
      // First file succeeds, second fails (fpcalc error)
      let callCount = 0;
      getMockedExecFile().mockImplementation(((
        _file: string,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ) => {
        callCount++;
        const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
        if (callCount === 1) {
          cb(null, JSON.stringify({ duration: 240, fingerprint: 'AQAA_ok' }), '');
        } else {
          const error = new Error('corrupted file') as NodeJS.ErrnoException;
          cb(error, '', 'error output');
        }
      }) as unknown as typeof childProcess.execFile);

      mockAcoustIdSuccess([{ id: 'ok-1', score: 0.9, recordings: [] }]);

      const results = await fingerprintMultipleFiles(
        [fixture('silence.mp3'), fixture('corrupt.mp3')],
        DEFAULT_OPTIONS,
      );

      expect(results).toHaveLength(2);

      // First should succeed
      expect(results[0].results).not.toBeNull();
      expect(results[0].error).toBeNull();

      // Second should fail gracefully
      expect(results[1].results).toBeNull();
      expect(results[1].error).not.toBeNull();
      expect(results[1].error).toContain('fpcalc failed');
    });

    it('should handle an empty array', async () => {
      const results = await fingerprintMultipleFiles([], DEFAULT_OPTIONS);
      expect(results).toEqual([]);
    });

    it('should use shared cache across files', async () => {
      mockFpcalcSuccess(240, 'AQAA_shared');
      mockAcoustIdSuccess([{ id: 'shared-1', score: 0.88, recordings: [] }]);

      const cache = new FingerprintCache();

      // Process same file twice
      const results = await fingerprintMultipleFiles(
        [fixture('silence.mp3'), fixture('silence.mp3')],
        DEFAULT_OPTIONS,
        cache,
      );

      expect(results).toHaveLength(2);
      expect(results[0].results).toEqual(results[1].results);

      // fpcalc and API should only be called once (second time uses cache)
      expect(getMockedExecFile()).toHaveBeenCalledTimes(1);
    });

    it('should handle all files failing', async () => {
      mockFpcalcError('all files corrupt');

      const results = await fingerprintMultipleFiles(
        [fixture('corrupt.mp3'), fixture('notaudio.mp3')],
        DEFAULT_OPTIONS,
      );

      expect(results).toHaveLength(2);
      results.forEach((result) => {
        expect(result.results).toBeNull();
        expect(result.error).not.toBeNull();
      });
    });
  });

  // ─── Integration-style tests (mocked) ─────────────────────────────────

  describe('integration (mocked)', () => {
    it('should handle the full flow: fpcalc -> API -> results with high confidence match', async () => {
      mockFpcalcSuccess(245.3, 'AQAAfull_integration_test');
      mockAcoustIdSuccess([
        {
          id: 'acoust-best',
          score: 0.98,
          recordings: [
            { id: '12345678-abcd-1234-abcd-123456789abc' },
            { id: 'secondary-recording-id' },
          ],
        },
        {
          id: 'acoust-low',
          score: 0.3,
          recordings: [{ id: 'low-quality-match' }],
        },
      ]);

      const options: FingerprinterOptions = {
        apiKey: 'production-key-123',
        fpcalcPath: '/opt/chromaprint/fpcalc',
        minScore: 0.9,
      };

      const cache = new FingerprintCache();
      const testRateLimiter = new RateLimiter(1);

      const results = await fingerprintFile(fixture('tagged.mp3'), options, cache, testRateLimiter);

      // Only high-confidence result should be included
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.98);
      expect(results[0].acoustId).toBe('acoust-best');
      expect(results[0].recordingIds).toHaveLength(2);
      expect(results[0].recordingIds[0]).toBe('12345678-abcd-1234-abcd-123456789abc');

      // Result should be cached
      expect(cache.has(path.resolve(fixture('tagged.mp3')))).toBe(true);
    });

    it('should handle the flow with no matches gracefully', async () => {
      mockFpcalcSuccess(10, 'AQAAshort_audio');
      mockAcoustIdSuccess([]); // No matches

      const results = await fingerprintFile(
        fixture('silence.mp3'),
        DEFAULT_OPTIONS,
        new FingerprintCache(),
        new RateLimiter(1),
      );

      expect(results).toEqual([]);
    });

    it('should return high confidence results (score > 0.9)', async () => {
      mockFpcalcSuccess(200, 'AQAAconfidence_test');
      mockAcoustIdSuccess([
        { id: 'high', score: 0.95, recordings: [{ id: 'rec-h' }] },
        { id: 'medium', score: 0.6, recordings: [{ id: 'rec-m' }] },
        { id: 'low', score: 0.2, recordings: [{ id: 'rec-l' }] },
      ]);

      const options: FingerprinterOptions = {
        ...DEFAULT_OPTIONS,
        minScore: 0.9,
      };

      const results = await fingerprintFile(
        fixture('silence.mp3'),
        options,
        new FingerprintCache(),
        new RateLimiter(1),
      );

      expect(results).toHaveLength(1);
      expect(results[0].score).toBeGreaterThanOrEqual(0.9);
    });
  });
});
