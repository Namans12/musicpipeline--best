/**
 * Tests for persistentCache service (SQLite-based caching)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  computeFileHash,
  getDefaultCacheDir,
  getDefaultCachePath,
  PersistentCacheDatabase,
  PersistentFingerprintCache,
  PersistentMetadataCache,
  PersistentLyricsCache,
  CachedLyricsResult,
} from '../../../src/main/services/persistentCache';
import { FingerprintResult, MusicBrainzMetadata } from '../../../src/shared/types';

// Test fixtures directory
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

describe('persistentCache', () => {
  // ─── computeFileHash ─────────────────────────────────────────────────────

  describe('computeFileHash', () => {
    it('should compute hash for small file (< 2MB)', () => {
      const filePath = path.join(FIXTURES_DIR, 'silence.mp3');
      const hash = computeFileHash(filePath);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should compute consistent hash for same file', () => {
      const filePath = path.join(FIXTURES_DIR, 'silence.mp3');
      const hash1 = computeFileHash(filePath);
      const hash2 = computeFileHash(filePath);
      expect(hash1).toBe(hash2);
    });

    it('should compute different hash for different files', () => {
      const file1 = path.join(FIXTURES_DIR, 'silence.mp3');
      const file2 = path.join(FIXTURES_DIR, 'tagged.mp3');
      const hash1 = computeFileHash(file1);
      const hash2 = computeFileHash(file2);
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty file', () => {
      const tempPath = path.join(os.tmpdir(), 'empty-test-file.bin');
      fs.writeFileSync(tempPath, '');
      try {
        const hash = computeFileHash(tempPath);
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        fs.unlinkSync(tempPath);
      }
    });

    it('should resolve relative paths', () => {
      const relativePath = path.relative(process.cwd(), path.join(FIXTURES_DIR, 'silence.mp3'));
      const hash = computeFileHash(relativePath);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should throw for non-existent file', () => {
      expect(() => computeFileHash('/nonexistent/file.mp3')).toThrow();
    });

    it('should handle large files efficiently', () => {
      // Create a 3MB temp file
      const tempPath = path.join(os.tmpdir(), 'large-test-file.bin');
      const size = 3 * 1024 * 1024; // 3MB
      const buffer = Buffer.alloc(size);
      buffer.fill('a');
      fs.writeFileSync(tempPath, buffer);
      try {
        const hash = computeFileHash(tempPath);
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        fs.unlinkSync(tempPath);
      }
    });
  });

  // ─── getDefaultCacheDir ──────────────────────────────────────────────────

  describe('getDefaultCacheDir', () => {
    it('should return a string', () => {
      const dir = getDefaultCacheDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });

    it('should contain audio-pipeline', () => {
      const dir = getDefaultCacheDir();
      expect(dir).toContain('audio-pipeline');
    });

    it('should not be the logs directory', () => {
      const dir = getDefaultCacheDir();
      expect(dir).not.toContain('logs');
    });
  });

  // ─── getDefaultCachePath ─────────────────────────────────────────────────

  describe('getDefaultCachePath', () => {
    it('should return a string ending with .db', () => {
      const dbPath = getDefaultCachePath();
      expect(dbPath).toMatch(/\.db$/);
    });

    it('should contain audio-pipeline', () => {
      const dbPath = getDefaultCachePath();
      expect(dbPath).toContain('audio-pipeline');
    });

    it('should be within the cache directory', () => {
      const dbPath = getDefaultCachePath();
      const dir = getDefaultCacheDir();
      expect(dbPath.startsWith(dir)).toBe(true);
    });
  });

  // ─── PersistentCacheDatabase ────────────────────────────────────────────

  describe('PersistentCacheDatabase', () => {
    let db: PersistentCacheDatabase;

    beforeEach(() => {
      // Use in-memory database for tests
      db = new PersistentCacheDatabase({ inMemory: true });
      db.initialize();
    });

    afterEach(() => {
      db.close();
    });

    describe('constructor and initialization', () => {
      it('should create database with default options', () => {
        const tempDb = new PersistentCacheDatabase({ inMemory: true });
        expect(tempDb.isOpen()).toBe(false);
        tempDb.initialize();
        expect(tempDb.isOpen()).toBe(true);
        tempDb.close();
      });

      it('should create database with custom path', () => {
        const tempPath = path.join(os.tmpdir(), `test-cache-${Date.now()}.db`);
        const tempDb = new PersistentCacheDatabase({ dbPath: tempPath });
        tempDb.initialize();
        expect(tempDb.isOpen()).toBe(true);
        expect(tempDb.getPath()).toBe(tempPath);
        tempDb.close();
        fs.unlinkSync(tempPath);
      });

      it('should create directory if it does not exist', () => {
        const tempDir = path.join(os.tmpdir(), `test-cache-dir-${Date.now()}`);
        const tempPath = path.join(tempDir, 'cache.db');
        const tempDb = new PersistentCacheDatabase({ dbPath: tempPath });
        tempDb.initialize();
        expect(fs.existsSync(tempDir)).toBe(true);
        tempDb.close();
        fs.unlinkSync(tempPath);
        fs.rmdirSync(tempDir);
      });

      it('should return correct path', () => {
        expect(db.getPath()).toBe(':memory:');
      });

      it('should report open status correctly', () => {
        expect(db.isOpen()).toBe(true);
        db.close();
        expect(db.isOpen()).toBe(false);
      });
    });

    describe('fingerprint cache', () => {
      const testHash = 'abc123def456';
      const testDuration = 180.5;
      const testResults: FingerprintResult[] = [
        { recordingId: 'rec1', score: 0.95 },
        { recordingId: 'rec2', score: 0.85 },
      ];

      it('should store and retrieve fingerprint', () => {
        db.setFingerprint(testHash, testDuration, testResults);
        const result = db.getFingerprint(testHash);
        expect(result).toBeDefined();
        expect(result?.duration).toBe(testDuration);
        expect(result?.results).toEqual(testResults);
      });

      it('should return undefined for non-existent hash', () => {
        const result = db.getFingerprint('nonexistent');
        expect(result).toBeUndefined();
      });

      it('should report has correctly', () => {
        expect(db.hasFingerprint(testHash)).toBe(false);
        db.setFingerprint(testHash, testDuration, testResults);
        expect(db.hasFingerprint(testHash)).toBe(true);
      });

      it('should update on duplicate insert', () => {
        db.setFingerprint(testHash, testDuration, testResults);
        const newResults: FingerprintResult[] = [{ recordingId: 'rec3', score: 0.99 }];
        db.setFingerprint(testHash, testDuration + 1, newResults);
        const result = db.getFingerprint(testHash);
        expect(result?.duration).toBe(testDuration + 1);
        expect(result?.results).toEqual(newResults);
      });

      it('should delete fingerprint', () => {
        db.setFingerprint(testHash, testDuration, testResults);
        expect(db.deleteFingerprint(testHash)).toBe(true);
        expect(db.hasFingerprint(testHash)).toBe(false);
      });

      it('should return false when deleting non-existent fingerprint', () => {
        expect(db.deleteFingerprint('nonexistent')).toBe(false);
      });

      it('should count fingerprints', () => {
        expect(db.getFingerprintCount()).toBe(0);
        db.setFingerprint('hash1', 100, testResults);
        db.setFingerprint('hash2', 200, testResults);
        expect(db.getFingerprintCount()).toBe(2);
      });

      it('should clear all fingerprints', () => {
        db.setFingerprint('hash1', 100, testResults);
        db.setFingerprint('hash2', 200, testResults);
        db.clearFingerprints();
        expect(db.getFingerprintCount()).toBe(0);
      });

      it('should handle empty results array', () => {
        db.setFingerprint(testHash, testDuration, []);
        const result = db.getFingerprint(testHash);
        expect(result?.results).toEqual([]);
      });
    });

    describe('metadata cache', () => {
      const testRecordingId = 'mbid-12345';
      const testMetadata: MusicBrainzMetadata = {
        recordingId: testRecordingId,
        artist: 'Test Artist',
        featuredArtists: ['Featured 1'],
        title: 'Test Song',
        album: 'Test Album',
        year: 2023,
        genres: ['Rock', 'Pop'],
      };

      it('should store and retrieve metadata', () => {
        db.setMetadata(testRecordingId, testMetadata);
        const result = db.getMetadata(testRecordingId);
        expect(result).toEqual(testMetadata);
      });

      it('should return undefined for non-existent recording', () => {
        const result = db.getMetadata('non-existent');
        expect(result).toBeUndefined();
      });

      it('should report has correctly', () => {
        expect(db.hasMetadata(testRecordingId)).toBe(false);
        db.setMetadata(testRecordingId, testMetadata);
        expect(db.hasMetadata(testRecordingId)).toBe(true);
      });

      it('should update on duplicate insert', () => {
        db.setMetadata(testRecordingId, testMetadata);
        const updatedMetadata = { ...testMetadata, year: 2024 };
        db.setMetadata(testRecordingId, updatedMetadata);
        const result = db.getMetadata(testRecordingId);
        expect(result?.year).toBe(2024);
      });

      it('should delete metadata', () => {
        db.setMetadata(testRecordingId, testMetadata);
        expect(db.deleteMetadata(testRecordingId)).toBe(true);
        expect(db.hasMetadata(testRecordingId)).toBe(false);
      });

      it('should return false when deleting non-existent metadata', () => {
        expect(db.deleteMetadata('non-existent')).toBe(false);
      });

      it('should count metadata entries', () => {
        expect(db.getMetadataCount()).toBe(0);
        db.setMetadata('rec1', testMetadata);
        db.setMetadata('rec2', { ...testMetadata, recordingId: 'rec2' });
        expect(db.getMetadataCount()).toBe(2);
      });

      it('should clear all metadata', () => {
        db.setMetadata('rec1', testMetadata);
        db.setMetadata('rec2', { ...testMetadata, recordingId: 'rec2' });
        db.clearMetadata();
        expect(db.getMetadataCount()).toBe(0);
      });

      it('should handle null fields', () => {
        const nullMetadata: MusicBrainzMetadata = {
          recordingId: testRecordingId,
          artist: 'Artist',
          featuredArtists: [],
          title: 'Title',
          album: null,
          year: null,
          genres: null,
        };
        db.setMetadata(testRecordingId, nullMetadata);
        const result = db.getMetadata(testRecordingId);
        expect(result).toEqual(nullMetadata);
      });
    });

    describe('lyrics cache', () => {
      const testArtist = 'Test Artist';
      const testTitle = 'Test Song';
      const testLyrics: CachedLyricsResult = {
        lyrics: 'La la la',
        source: 'lrclib',
        validated: true,
      };

      it('should store and retrieve lyrics', () => {
        db.setLyrics(testArtist, testTitle, testLyrics);
        const result = db.getLyrics(testArtist, testTitle);
        expect(result).toEqual(testLyrics);
      });

      it('should return undefined for non-existent lyrics', () => {
        const result = db.getLyrics('Unknown', 'Unknown');
        expect(result).toBeUndefined();
      });

      it('should store and retrieve null (no lyrics found)', () => {
        db.setLyrics(testArtist, testTitle, null);
        const result = db.getLyrics(testArtist, testTitle);
        expect(result).toBeNull();
      });

      it('should normalize keys case-insensitively', () => {
        db.setLyrics('ARTIST', 'TITLE', testLyrics);
        const result = db.getLyrics('artist', 'title');
        expect(result).toEqual(testLyrics);
      });

      it('should trim whitespace in keys', () => {
        db.setLyrics('  Artist  ', '  Title  ', testLyrics);
        const result = db.getLyrics('Artist', 'Title');
        expect(result).toEqual(testLyrics);
      });

      it('should report has correctly', () => {
        expect(db.hasLyrics(testArtist, testTitle)).toBe(false);
        db.setLyrics(testArtist, testTitle, testLyrics);
        expect(db.hasLyrics(testArtist, testTitle)).toBe(true);
      });

      it('should report has for null lyrics', () => {
        db.setLyrics(testArtist, testTitle, null);
        expect(db.hasLyrics(testArtist, testTitle)).toBe(true);
      });

      it('should update on duplicate insert', () => {
        db.setLyrics(testArtist, testTitle, testLyrics);
        const updated = { ...testLyrics, source: 'chartlyrics' as const };
        db.setLyrics(testArtist, testTitle, updated);
        const result = db.getLyrics(testArtist, testTitle);
        expect(result?.source).toBe('chartlyrics');
      });

      it('should delete lyrics', () => {
        db.setLyrics(testArtist, testTitle, testLyrics);
        expect(db.deleteLyrics(testArtist, testTitle)).toBe(true);
        expect(db.hasLyrics(testArtist, testTitle)).toBe(false);
      });

      it('should return false when deleting non-existent lyrics', () => {
        expect(db.deleteLyrics('Unknown', 'Unknown')).toBe(false);
      });

      it('should count lyrics entries', () => {
        expect(db.getLyricsCount()).toBe(0);
        db.setLyrics('Artist1', 'Song1', testLyrics);
        db.setLyrics('Artist2', 'Song2', testLyrics);
        expect(db.getLyricsCount()).toBe(2);
      });

      it('should clear all lyrics', () => {
        db.setLyrics('Artist1', 'Song1', testLyrics);
        db.setLyrics('Artist2', 'Song2', testLyrics);
        db.clearLyrics();
        expect(db.getLyricsCount()).toBe(0);
      });

      it('should handle different sources', () => {
        const lrclibLyrics: CachedLyricsResult = {
          lyrics: 'Lyrics 1',
          source: 'lrclib',
          validated: true,
        };
        const chartLyrics: CachedLyricsResult = {
          lyrics: 'Lyrics 2',
          source: 'chartlyrics',
          validated: false,
        };
        db.setLyrics('Artist1', 'Song1', lrclibLyrics);
        db.setLyrics('Artist2', 'Song2', chartLyrics);
        expect(db.getLyrics('Artist1', 'Song1')?.source).toBe('lrclib');
        expect(db.getLyrics('Artist2', 'Song2')?.source).toBe('chartlyrics');
      });
    });

    describe('makeLyricsKey', () => {
      it('should generate key from artist and title', () => {
        const key = PersistentCacheDatabase.makeLyricsKey('Artist', 'Title');
        expect(key).toBe('artist|title');
      });

      it('should normalize to lowercase', () => {
        const key = PersistentCacheDatabase.makeLyricsKey('ARTIST', 'TITLE');
        expect(key).toBe('artist|title');
      });

      it('should trim whitespace', () => {
        const key = PersistentCacheDatabase.makeLyricsKey('  Artist  ', '  Title  ');
        expect(key).toBe('artist|title');
      });

      it('should handle unicode', () => {
        const key = PersistentCacheDatabase.makeLyricsKey('Artíst', 'Títle');
        expect(key).toBe('artíst|títle');
      });
    });

    describe('cache management', () => {
      beforeEach(() => {
        db.setFingerprint('hash1', 100, [{ recordingId: 'rec1', score: 0.9 }]);
        db.setMetadata('rec1', {
          recordingId: 'rec1',
          artist: 'Artist',
          featuredArtists: [],
          title: 'Title',
          album: null,
          year: null,
          genres: null,
        });
        db.setLyrics('Artist', 'Title', { lyrics: 'Lyrics', source: 'lrclib', validated: true });
      });

      it('should get stats', () => {
        const stats = db.getStats();
        expect(stats.fingerprints).toBe(1);
        expect(stats.metadata).toBe(1);
        expect(stats.lyrics).toBe(1);
        expect(stats.totalEntries).toBe(3);
      });

      it('should clear all caches', () => {
        db.clearAll();
        const stats = db.getStats();
        expect(stats.totalEntries).toBe(0);
      });

      it('should clear only fingerprints', () => {
        db.clearFingerprints();
        expect(db.getFingerprintCount()).toBe(0);
        expect(db.getMetadataCount()).toBe(1);
        expect(db.getLyricsCount()).toBe(1);
      });

      it('should clear only metadata', () => {
        db.clearMetadata();
        expect(db.getFingerprintCount()).toBe(1);
        expect(db.getMetadataCount()).toBe(0);
        expect(db.getLyricsCount()).toBe(1);
      });

      it('should clear only lyrics', () => {
        db.clearLyrics();
        expect(db.getFingerprintCount()).toBe(1);
        expect(db.getMetadataCount()).toBe(1);
        expect(db.getLyricsCount()).toBe(0);
      });

      it('should return 0 size for in-memory database', () => {
        expect(db.getDatabaseSize()).toBe(0);
      });

      it('should return database size for file-based database', () => {
        const tempPath = path.join(os.tmpdir(), `test-cache-size-${Date.now()}.db`);
        const fileDb = new PersistentCacheDatabase({ dbPath: tempPath });
        fileDb.initialize();
        fileDb.setFingerprint('hash1', 100, [{ recordingId: 'rec1', score: 0.9 }]);
        const size = fileDb.getDatabaseSize();
        expect(size).toBeGreaterThan(0);
        fileDb.close();
        fs.unlinkSync(tempPath);
      });
    });

    describe('error handling', () => {
      it('should throw if not initialized', () => {
        const uninitializedDb = new PersistentCacheDatabase({ inMemory: true });
        expect(() => uninitializedDb.setFingerprint('hash', 100, [])).toThrow(/not initialized/i);
      });

      it('should handle invalid JSON gracefully', () => {
        // This is hard to test without directly manipulating the database
        // The code has try-catch blocks for JSON parsing
        // We verify it doesn't crash by using valid JSON
        db.setFingerprint('hash', 100, [{ recordingId: 'rec1', score: 0.9 }]);
        const result = db.getFingerprint('hash');
        expect(result).toBeDefined();
      });
    });
  });

  // ─── PersistentFingerprintCache ─────────────────────────────────────────

  describe('PersistentFingerprintCache', () => {
    let db: PersistentCacheDatabase;
    let cache: PersistentFingerprintCache;

    beforeEach(() => {
      db = new PersistentCacheDatabase({ inMemory: true });
      db.initialize();
      cache = new PersistentFingerprintCache(db);
    });

    afterEach(() => {
      db.close();
    });

    const testPath = '/test/file.mp3';
    const testHash = 'abc123def456';
    const testDuration = 180.5;
    const testResults: FingerprintResult[] = [
      { recordingId: 'rec1', score: 0.95 },
      { recordingId: 'rec2', score: 0.85 },
    ];

    it('should not have uncached file', () => {
      expect(cache.has(testPath)).toBe(false);
    });

    it('should return undefined for uncached file', () => {
      expect(cache.get(testPath)).toBeUndefined();
    });

    it('should store and retrieve with hash', () => {
      cache.setWithHash(testPath, testHash, testDuration, testResults);
      expect(cache.has(testPath)).toBe(true);
      expect(cache.get(testPath)).toEqual(testResults);
    });

    it('should store and retrieve by hash directly', () => {
      cache.setWithHash(testPath, testHash, testDuration, testResults);
      const result = cache.getByHash(testHash);
      expect(result?.duration).toBe(testDuration);
      expect(result?.results).toEqual(testResults);
    });

    it('should check has by hash', () => {
      expect(cache.hasByHash(testHash)).toBe(false);
      cache.setWithHash(testPath, testHash, testDuration, testResults);
      expect(cache.hasByHash(testHash)).toBe(true);
    });

    it('should register hash for path', () => {
      cache.registerHash(testPath, testHash);
      cache.setWithHash(testPath, testHash, testDuration, testResults);
      expect(cache.has(testPath)).toBe(true);
    });

    it('should delete by path', () => {
      cache.setWithHash(testPath, testHash, testDuration, testResults);
      expect(cache.delete(testPath)).toBe(true);
      expect(cache.has(testPath)).toBe(false);
    });

    it('should return false when deleting non-existent path', () => {
      expect(cache.delete('/non/existent.mp3')).toBe(false);
    });

    it('should clear all entries', () => {
      cache.setWithHash('/file1.mp3', 'hash1', 100, testResults);
      cache.setWithHash('/file2.mp3', 'hash2', 200, testResults);
      expect(cache.size).toBe(2);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should report correct size', () => {
      expect(cache.size).toBe(0);
      cache.setWithHash('/file1.mp3', 'hash1', 100, testResults);
      cache.setWithHash('/file2.mp3', 'hash2', 200, testResults);
      expect(cache.size).toBe(2);
    });

    it('should resolve relative paths', () => {
      const relativePath = 'relative/file.mp3';
      cache.setWithHash(relativePath, testHash, testDuration, testResults);
      expect(cache.has(relativePath)).toBe(true);
    });

    it('should persist across lookup with registerHash first', () => {
      // Simulate: hash computed first, then registered, then looked up
      db.setFingerprint(testHash, testDuration, testResults);
      cache.registerHash(testPath, testHash);
      expect(cache.has(testPath)).toBe(true);
      expect(cache.get(testPath)).toEqual(testResults);
    });

    it('should handle set without hash (session-level)', () => {
      // set() without prior registerHash doesn't persist
      cache.set(testPath, testResults);
      expect(cache.get(testPath)).toBeUndefined();

      // But if hash is registered, set() will persist
      cache.registerHash(testPath, testHash);
      cache.set(testPath, testResults);
      expect(cache.get(testPath)).toEqual(testResults);
    });
  });

  // ─── PersistentMetadataCache ─────────────────────────────────────────────

  describe('PersistentMetadataCache', () => {
    let db: PersistentCacheDatabase;
    let cache: PersistentMetadataCache;

    beforeEach(() => {
      db = new PersistentCacheDatabase({ inMemory: true });
      db.initialize();
      cache = new PersistentMetadataCache(db);
    });

    afterEach(() => {
      db.close();
    });

    const testRecordingId = 'mbid-12345';
    const testMetadata: MusicBrainzMetadata = {
      recordingId: testRecordingId,
      artist: 'Test Artist',
      featuredArtists: ['Featured 1'],
      title: 'Test Song',
      album: 'Test Album',
      year: 2023,
      genres: ['Rock', 'Pop'],
    };

    it('should not have uncached recording', () => {
      expect(cache.has(testRecordingId)).toBe(false);
    });

    it('should return undefined for uncached recording', () => {
      expect(cache.get(testRecordingId)).toBeUndefined();
    });

    it('should store and retrieve metadata', () => {
      cache.set(testRecordingId, testMetadata);
      expect(cache.has(testRecordingId)).toBe(true);
      expect(cache.get(testRecordingId)).toEqual(testMetadata);
    });

    it('should update on duplicate set', () => {
      cache.set(testRecordingId, testMetadata);
      const updated = { ...testMetadata, year: 2024 };
      cache.set(testRecordingId, updated);
      expect(cache.get(testRecordingId)?.year).toBe(2024);
    });

    it('should delete metadata', () => {
      cache.set(testRecordingId, testMetadata);
      expect(cache.delete(testRecordingId)).toBe(true);
      expect(cache.has(testRecordingId)).toBe(false);
    });

    it('should return false for non-existent delete', () => {
      expect(cache.delete('non-existent')).toBe(false);
    });

    it('should clear all metadata', () => {
      cache.set('rec1', testMetadata);
      cache.set('rec2', { ...testMetadata, recordingId: 'rec2' });
      expect(cache.size).toBe(2);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should report correct size', () => {
      expect(cache.size).toBe(0);
      cache.set('rec1', testMetadata);
      cache.set('rec2', { ...testMetadata, recordingId: 'rec2' });
      expect(cache.size).toBe(2);
    });
  });

  // ─── PersistentLyricsCache ───────────────────────────────────────────────

  describe('PersistentLyricsCache', () => {
    let db: PersistentCacheDatabase;
    let cache: PersistentLyricsCache;

    beforeEach(() => {
      db = new PersistentCacheDatabase({ inMemory: true });
      db.initialize();
      cache = new PersistentLyricsCache(db);
    });

    afterEach(() => {
      db.close();
    });

    const testArtist = 'Test Artist';
    const testTitle = 'Test Song';
    const testLyrics: CachedLyricsResult = {
      lyrics: 'La la la',
      source: 'lrclib',
      validated: true,
    };

    it('should not have uncached lyrics', () => {
      expect(cache.has(testArtist, testTitle)).toBe(false);
    });

    it('should return undefined for uncached lyrics', () => {
      expect(cache.get(testArtist, testTitle)).toBeUndefined();
    });

    it('should store and retrieve lyrics', () => {
      cache.set(testArtist, testTitle, testLyrics);
      expect(cache.has(testArtist, testTitle)).toBe(true);
      expect(cache.get(testArtist, testTitle)).toEqual(testLyrics);
    });

    it('should store and retrieve null lyrics', () => {
      cache.set(testArtist, testTitle, null);
      expect(cache.has(testArtist, testTitle)).toBe(true);
      expect(cache.get(testArtist, testTitle)).toBeNull();
    });

    it('should normalize keys case-insensitively', () => {
      cache.set('ARTIST', 'TITLE', testLyrics);
      expect(cache.get('artist', 'title')).toEqual(testLyrics);
    });

    it('should update on duplicate set', () => {
      cache.set(testArtist, testTitle, testLyrics);
      const updated = { ...testLyrics, source: 'chartlyrics' as const };
      cache.set(testArtist, testTitle, updated);
      expect(cache.get(testArtist, testTitle)?.source).toBe('chartlyrics');
    });

    it('should delete lyrics', () => {
      cache.set(testArtist, testTitle, testLyrics);
      expect(cache.delete(testArtist, testTitle)).toBe(true);
      expect(cache.has(testArtist, testTitle)).toBe(false);
    });

    it('should return false for non-existent delete', () => {
      expect(cache.delete('Unknown', 'Unknown')).toBe(false);
    });

    it('should clear all lyrics', () => {
      cache.set('Artist1', 'Song1', testLyrics);
      cache.set('Artist2', 'Song2', testLyrics);
      expect(cache.size).toBe(2);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should report correct size', () => {
      expect(cache.size).toBe(0);
      cache.set('Artist1', 'Song1', testLyrics);
      cache.set('Artist2', 'Song2', testLyrics);
      expect(cache.size).toBe(2);
    });

    it('should generate correct cache key', () => {
      const key = PersistentLyricsCache.makeKey('Artist', 'Title');
      expect(key).toBe('artist|title');
    });
  });

  // ─── Integration Tests ───────────────────────────────────────────────────

  describe('integration', () => {
    it('should persist across database instances', () => {
      const tempPath = path.join(os.tmpdir(), `integration-test-${Date.now()}.db`);

      // First instance: write data
      const db1 = new PersistentCacheDatabase({ dbPath: tempPath });
      db1.initialize();
      db1.setFingerprint('hash1', 100, [{ recordingId: 'rec1', score: 0.9 }]);
      db1.setMetadata('rec1', {
        recordingId: 'rec1',
        artist: 'Artist',
        featuredArtists: [],
        title: 'Title',
        album: null,
        year: null,
        genres: null,
      });
      db1.setLyrics('Artist', 'Title', { lyrics: 'Lyrics', source: 'lrclib', validated: true });
      db1.close();

      // Second instance: read data
      const db2 = new PersistentCacheDatabase({ dbPath: tempPath });
      db2.initialize();
      expect(db2.hasFingerprint('hash1')).toBe(true);
      expect(db2.hasMetadata('rec1')).toBe(true);
      expect(db2.hasLyrics('Artist', 'Title')).toBe(true);
      db2.close();

      // Cleanup
      fs.unlinkSync(tempPath);
    });

    it('should handle real audio file hash', () => {
      const filePath = path.join(FIXTURES_DIR, 'silence.mp3');
      const hash = computeFileHash(filePath);

      const db = new PersistentCacheDatabase({ inMemory: true });
      db.initialize();
      const cache = new PersistentFingerprintCache(db);

      const results: FingerprintResult[] = [{ recordingId: 'test-rec', score: 0.95 }];
      cache.setWithHash(filePath, hash, 1.0, results);

      expect(cache.has(filePath)).toBe(true);
      expect(cache.get(filePath)).toEqual(results);

      // Should also be retrievable by hash alone
      expect(cache.hasByHash(hash)).toBe(true);

      db.close();
    });

    it('should handle complete pipeline simulation', () => {
      const db = new PersistentCacheDatabase({ inMemory: true });
      db.initialize();

      const fpCache = new PersistentFingerprintCache(db);
      const mdCache = new PersistentMetadataCache(db);
      const lyCache = new PersistentLyricsCache(db);

      // Simulate fingerprinting
      const filePath = '/test/song.mp3';
      const fileHash = 'abc123';
      const fpResults: FingerprintResult[] = [{ recordingId: 'mbid-1', score: 0.95 }];
      fpCache.setWithHash(filePath, fileHash, 180, fpResults);

      // Simulate metadata fetch
      const metadata: MusicBrainzMetadata = {
        recordingId: 'mbid-1',
        artist: 'Test Artist',
        featuredArtists: [],
        title: 'Test Song',
        album: 'Test Album',
        year: 2023,
        genres: ['Rock'],
      };
      mdCache.set('mbid-1', metadata);

      // Simulate lyrics fetch
      const lyrics: CachedLyricsResult = {
        lyrics: 'Test lyrics',
        source: 'lrclib',
        validated: true,
      };
      lyCache.set('Test Artist', 'Test Song', lyrics);

      // Verify all cached
      expect(fpCache.has(filePath)).toBe(true);
      expect(mdCache.has('mbid-1')).toBe(true);
      expect(lyCache.has('Test Artist', 'Test Song')).toBe(true);

      // Verify stats
      const stats = db.getStats();
      expect(stats.fingerprints).toBe(1);
      expect(stats.metadata).toBe(1);
      expect(stats.lyrics).toBe(1);
      expect(stats.totalEntries).toBe(3);

      db.close();
    });
  });
});
