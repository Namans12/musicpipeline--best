/**
 * Persistent Cache Service (SQLite)
 *
 * Provides SQLite-based persistent caching for the audio processing pipeline.
 * Caches file hash → fingerprint results, MusicBrainz Recording ID → metadata,
 * and artist+title → lyrics to avoid redundant API calls across sessions.
 *
 * File hash: SHA-256 of first 1MB + last 1MB (fast, collision-resistant).
 * Cache expiration: never (metadata doesn't change), or user-triggered "Clear Cache".
 *
 * The persistent caches implement the same public interface as their in-memory
 * counterparts (FingerprintCache, MetadataCache, LyricsCache) so they can be
 * used as drop-in replacements in the BatchProcessor.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { FingerprintResult, MusicBrainzMetadata } from '../../shared/types';
import type { IFingerprintCache } from './fingerprinter';
import type { IMetadataCache } from './metadataFetcher';
import type { ILyricsCache } from './lyricsFetcher';

// Re-use the LyricsResult type from the lyrics fetcher
// We inline the shape here to avoid circular dependency concerns
export interface CachedLyricsResult {
  /** The plain text lyrics */
  lyrics: string;
  /** Source of the lyrics (lrclib, chartlyrics) */
  source: 'lrclib' | 'chartlyrics';
  /** Whether the lyrics were validated against the query */
  validated: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Size of chunk to read from file start/end for hashing (1MB) */
const HASH_CHUNK_SIZE = 1024 * 1024; // 1MB

/** Current schema version for migration support */
const SCHEMA_VERSION = 1;

// ─── File Hashing ────────────────────────────────────────────────────────────

/**
 * Computes a fast, collision-resistant hash of an audio file.
 * Uses SHA-256 of the first 1MB + last 1MB of the file.
 * For files smaller than 2MB, hashes the entire file.
 *
 * @param filePath - Absolute path to the audio file
 * @returns A hex-encoded SHA-256 hash string
 * @throws Error if the file cannot be read
 */
export function computeFileHash(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const stat = fs.statSync(resolvedPath);
  const fileSize = stat.size;

  if (fileSize === 0) {
    // Hash of empty content
    return crypto.createHash('sha256').update('').digest('hex');
  }

  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(resolvedPath, 'r');

  try {
    if (fileSize <= HASH_CHUNK_SIZE * 2) {
      // File is small enough to read entirely
      const buffer = Buffer.alloc(fileSize);
      fs.readSync(fd, buffer, 0, fileSize, 0);
      hash.update(buffer);
    } else {
      // Read first 1MB
      const firstChunk = Buffer.alloc(HASH_CHUNK_SIZE);
      fs.readSync(fd, firstChunk, 0, HASH_CHUNK_SIZE, 0);
      hash.update(firstChunk);

      // Read last 1MB
      const lastChunk = Buffer.alloc(HASH_CHUNK_SIZE);
      fs.readSync(fd, lastChunk, 0, HASH_CHUNK_SIZE, fileSize - HASH_CHUNK_SIZE);
      hash.update(lastChunk);
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

// ─── Database Default Path ───────────────────────────────────────────────────

/**
 * Returns the default path for the SQLite database file.
 * Platform-specific: %APPDATA%/audio-pipeline/ on Windows,
 * ~/.config/audio-pipeline/ on other platforms.
 */
export function getDefaultCacheDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'audio-pipeline');
  }
  return path.join(os.homedir(), '.config', 'audio-pipeline');
}

/**
 * Returns the default path for the cache database file.
 */
export function getDefaultCachePath(): string {
  return path.join(getDefaultCacheDir(), 'cache.db');
}

// ─── Persistent Cache Database ───────────────────────────────────────────────

/** Options for PersistentCacheDatabase */
export interface PersistentCacheOptions {
  /** Path to the SQLite database file. Defaults to %APPDATA%/audio-pipeline/cache.db */
  dbPath?: string;
  /** Whether to use in-memory database (for testing) */
  inMemory?: boolean;
}

/**
 * SQLite-based persistent cache database.
 *
 * Manages three cache tables:
 * 1. fingerprints: file_hash → fingerprint results (JSON)
 * 2. metadata: recording_id → MusicBrainz metadata (JSON)
 * 3. lyrics: artist_title_key → lyrics result (JSON)
 *
 * Thread-safe via SQLite's serialized mode (default in better-sqlite3).
 */
export class PersistentCacheDatabase {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private readonly inMemory: boolean;

  constructor(options: PersistentCacheOptions = {}) {
    this.inMemory = options.inMemory ?? false;
    this.dbPath = this.inMemory ? ':memory:' : (options.dbPath ?? getDefaultCachePath());
  }

  /**
   * Opens the database and creates tables if they don't exist.
   * Must be called before any cache operations.
   */
  initialize(): void {
    // Ensure directory exists (unless in-memory)
    if (!this.inMemory) {
      const dir = path.dirname(this.dbPath);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist, or creation may fail - we'll handle the DB open error
      }
    }

    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fingerprints (
        file_hash TEXT PRIMARY KEY,
        duration REAL NOT NULL,
        results_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS metadata (
        recording_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS lyrics (
        cache_key TEXT PRIMARY KEY,
        result_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Check and update schema version
    const versionRow = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    if (!versionRow) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }

  /**
   * Returns whether the database is open and initialized.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Returns the path to the database file.
   */
  getPath(): string {
    return this.dbPath;
  }

  // ─── Fingerprint Cache ─────────────────────────────────────────────────────

  /**
   * Stores fingerprint results for a file hash.
   */
  setFingerprint(fileHash: string, duration: number, results: FingerprintResult[]): void {
    this.ensureOpen();
    const json = JSON.stringify(results);
    this.db!.prepare(
      `INSERT OR REPLACE INTO fingerprints (file_hash, duration, results_json, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
    ).run(fileHash, duration, json);
  }

  /**
   * Retrieves cached fingerprint results for a file hash.
   * Returns undefined if not cached.
   */
  getFingerprint(fileHash: string): { duration: number; results: FingerprintResult[] } | undefined {
    this.ensureOpen();
    const row = this.db!.prepare(
      'SELECT duration, results_json FROM fingerprints WHERE file_hash = ?',
    ).get(fileHash) as { duration: number; results_json: string } | undefined;
    if (!row) return undefined;
    try {
      const results = JSON.parse(row.results_json) as FingerprintResult[];
      return { duration: row.duration, results };
    } catch {
      return undefined;
    }
  }

  /**
   * Checks if a fingerprint exists in the cache.
   */
  hasFingerprint(fileHash: string): boolean {
    this.ensureOpen();
    const row = this.db!.prepare('SELECT 1 FROM fingerprints WHERE file_hash = ?').get(fileHash);
    return row !== undefined;
  }

  /**
   * Removes a fingerprint entry.
   */
  deleteFingerprint(fileHash: string): boolean {
    this.ensureOpen();
    const result = this.db!.prepare('DELETE FROM fingerprints WHERE file_hash = ?').run(fileHash);
    return result.changes > 0;
  }

  /**
   * Returns the number of cached fingerprints.
   */
  getFingerprintCount(): number {
    this.ensureOpen();
    const row = this.db!.prepare('SELECT COUNT(*) as count FROM fingerprints').get() as {
      count: number;
    };
    return row.count;
  }

  // ─── Metadata Cache ────────────────────────────────────────────────────────

  /**
   * Stores MusicBrainz metadata for a recording ID.
   */
  setMetadata(recordingId: string, metadata: MusicBrainzMetadata): void {
    this.ensureOpen();
    const json = JSON.stringify(metadata);
    this.db!.prepare(
      `INSERT OR REPLACE INTO metadata (recording_id, metadata_json, created_at)
         VALUES (?, ?, datetime('now'))`,
    ).run(recordingId, json);
  }

  /**
   * Retrieves cached metadata for a recording ID.
   * Returns undefined if not cached.
   */
  getMetadata(recordingId: string): MusicBrainzMetadata | undefined {
    this.ensureOpen();
    const row = this.db!.prepare('SELECT metadata_json FROM metadata WHERE recording_id = ?').get(
      recordingId,
    ) as { metadata_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.metadata_json) as MusicBrainzMetadata;
    } catch {
      return undefined;
    }
  }

  /**
   * Checks if metadata exists for a recording ID.
   */
  hasMetadata(recordingId: string): boolean {
    this.ensureOpen();
    const row = this.db!.prepare('SELECT 1 FROM metadata WHERE recording_id = ?').get(recordingId);
    return row !== undefined;
  }

  /**
   * Removes a metadata entry.
   */
  deleteMetadata(recordingId: string): boolean {
    this.ensureOpen();
    const result = this.db!.prepare('DELETE FROM metadata WHERE recording_id = ?').run(recordingId);
    return result.changes > 0;
  }

  /**
   * Returns the number of cached metadata entries.
   */
  getMetadataCount(): number {
    this.ensureOpen();
    const row = this.db!.prepare('SELECT COUNT(*) as count FROM metadata').get() as {
      count: number;
    };
    return row.count;
  }

  // ─── Lyrics Cache ──────────────────────────────────────────────────────────

  /**
   * Generates a normalized cache key for lyrics (matches LyricsCache.makeKey).
   */
  static makeLyricsKey(artist: string, title: string): string {
    return `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`;
  }

  /**
   * Stores a lyrics result (or null for "no lyrics found").
   */
  setLyrics(artist: string, title: string, result: CachedLyricsResult | null): void {
    this.ensureOpen();
    const key = PersistentCacheDatabase.makeLyricsKey(artist, title);
    const json = result === null ? null : JSON.stringify(result);
    this.db!.prepare(
      `INSERT OR REPLACE INTO lyrics (cache_key, result_json, created_at)
         VALUES (?, ?, datetime('now'))`,
    ).run(key, json);
  }

  /**
   * Retrieves cached lyrics. Returns undefined if not cached.
   * Returns null if cached as "no lyrics found".
   */
  getLyrics(artist: string, title: string): CachedLyricsResult | null | undefined {
    this.ensureOpen();
    const key = PersistentCacheDatabase.makeLyricsKey(artist, title);
    const row = this.db!.prepare('SELECT result_json FROM lyrics WHERE cache_key = ?').get(key) as
      | { result_json: string | null }
      | undefined;
    if (row === undefined) return undefined; // Not in cache
    if (row.result_json === null) return null; // Cached as "no lyrics"
    try {
      return JSON.parse(row.result_json) as CachedLyricsResult;
    } catch {
      return undefined;
    }
  }

  /**
   * Checks if lyrics exist in the cache for a song.
   */
  hasLyrics(artist: string, title: string): boolean {
    this.ensureOpen();
    const key = PersistentCacheDatabase.makeLyricsKey(artist, title);
    const row = this.db!.prepare('SELECT 1 FROM lyrics WHERE cache_key = ?').get(key);
    return row !== undefined;
  }

  /**
   * Removes a lyrics entry.
   */
  deleteLyrics(artist: string, title: string): boolean {
    this.ensureOpen();
    const key = PersistentCacheDatabase.makeLyricsKey(artist, title);
    const result = this.db!.prepare('DELETE FROM lyrics WHERE cache_key = ?').run(key);
    return result.changes > 0;
  }

  /**
   * Returns the number of cached lyrics entries.
   */
  getLyricsCount(): number {
    this.ensureOpen();
    const row = this.db!.prepare('SELECT COUNT(*) as count FROM lyrics').get() as {
      count: number;
    };
    return row.count;
  }

  // ─── Cache Management ──────────────────────────────────────────────────────

  /**
   * Clears all cached data from all tables.
   */
  clearAll(): void {
    this.ensureOpen();
    this.db!.exec(`
      DELETE FROM fingerprints;
      DELETE FROM metadata;
      DELETE FROM lyrics;
    `);
  }

  /**
   * Clears only the fingerprints table.
   */
  clearFingerprints(): void {
    this.ensureOpen();
    this.db!.exec('DELETE FROM fingerprints');
  }

  /**
   * Clears only the metadata table.
   */
  clearMetadata(): void {
    this.ensureOpen();
    this.db!.exec('DELETE FROM metadata');
  }

  /**
   * Clears only the lyrics table.
   */
  clearLyrics(): void {
    this.ensureOpen();
    this.db!.exec('DELETE FROM lyrics');
  }

  /**
   * Returns a summary of cache statistics.
   */
  getStats(): { fingerprints: number; metadata: number; lyrics: number; totalEntries: number } {
    this.ensureOpen();
    const fp = this.getFingerprintCount();
    const md = this.getMetadataCount();
    const ly = this.getLyricsCount();
    return {
      fingerprints: fp,
      metadata: md,
      lyrics: ly,
      totalEntries: fp + md + ly,
    };
  }

  /**
   * Returns the SQLite database file size in bytes.
   * Returns 0 for in-memory databases.
   */
  getDatabaseSize(): number {
    if (this.inMemory) return 0;
    try {
      const stat = fs.statSync(this.dbPath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Ensures the database is open. Throws if not.
   */
  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('PersistentCacheDatabase is not initialized. Call initialize() first.');
    }
  }
}

// ─── Adapter Classes ─────────────────────────────────────────────────────────
// These wrap PersistentCacheDatabase to provide the same interface as the
// in-memory caches (FingerprintCache, MetadataCache, LyricsCache) for
// drop-in compatibility with existing services.

/**
 * Persistent fingerprint cache that wraps PersistentCacheDatabase.
 * Compatible with the FingerprintCache interface from fingerprinter.ts.
 *
 * Uses file hashing to enable cross-session caching:
 * - Caller must provide file hash via setWithHash() for persistence
 * - The standard set(filePath, results) also works for session-level caching
 */
export class PersistentFingerprintCache implements IFingerprintCache {
  private readonly db: PersistentCacheDatabase;
  /** In-memory path → hash mapping for the current session */
  private pathToHash: Map<string, string> = new Map();

  constructor(db: PersistentCacheDatabase) {
    this.db = db;
  }

  /**
   * Checks if results are cached for a file path.
   * Checks both in-memory path map and persistent hash map.
   */
  has(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const hash = this.pathToHash.get(resolved);
    if (hash) {
      return this.db.hasFingerprint(hash);
    }
    return false;
  }

  /**
   * Gets cached results for a file path.
   */
  get(filePath: string): FingerprintResult[] | undefined {
    const resolved = path.resolve(filePath);
    const hash = this.pathToHash.get(resolved);
    if (hash) {
      const result = this.db.getFingerprint(hash);
      return result?.results;
    }
    return undefined;
  }

  /**
   * Stores results for a file path (session-level, without hash).
   * For persistent storage, use setWithHash().
   */
  set(filePath: string, results: FingerprintResult[]): void {
    // If we have a hash mapping, persist to DB
    const resolved = path.resolve(filePath);
    const hash = this.pathToHash.get(resolved);
    if (hash) {
      this.db.setFingerprint(hash, 0, results);
    }
  }

  /**
   * Stores results with file hash for persistent caching.
   * This is the preferred method for cross-session persistence.
   */
  setWithHash(
    filePath: string,
    fileHash: string,
    duration: number,
    results: FingerprintResult[],
  ): void {
    const resolved = path.resolve(filePath);
    this.pathToHash.set(resolved, fileHash);
    this.db.setFingerprint(fileHash, duration, results);
  }

  /**
   * Looks up cached results by file hash directly.
   * Used when checking if a file needs fingerprinting.
   */
  getByHash(fileHash: string): { duration: number; results: FingerprintResult[] } | undefined {
    return this.db.getFingerprint(fileHash);
  }

  /**
   * Checks if a file hash has cached results.
   */
  hasByHash(fileHash: string): boolean {
    return this.db.hasFingerprint(fileHash);
  }

  /**
   * Registers a path → hash mapping for the current session.
   * Enables has()/get() by path after hash is computed.
   */
  registerHash(filePath: string, fileHash: string): void {
    const resolved = path.resolve(filePath);
    this.pathToHash.set(resolved, fileHash);
  }

  /** Remove a file from the cache */
  delete(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const hash = this.pathToHash.get(resolved);
    if (hash) {
      this.pathToHash.delete(resolved);
      return this.db.deleteFingerprint(hash);
    }
    return false;
  }

  /** Clear all cached results */
  clear(): void {
    this.pathToHash.clear();
    this.db.clearFingerprints();
  }

  /** Get the number of cached entries in the database */
  get size(): number {
    return this.db.getFingerprintCount();
  }
}

/**
 * Persistent metadata cache that wraps PersistentCacheDatabase.
 * Compatible with the MetadataCache interface from metadataFetcher.ts.
 */
export class PersistentMetadataCache implements IMetadataCache {
  private readonly db: PersistentCacheDatabase;

  constructor(db: PersistentCacheDatabase) {
    this.db = db;
  }

  /** Check if a recording's metadata is cached */
  has(recordingId: string): boolean {
    return this.db.hasMetadata(recordingId);
  }

  /** Get cached metadata for a recording */
  get(recordingId: string): MusicBrainzMetadata | undefined {
    return this.db.getMetadata(recordingId);
  }

  /** Store metadata for a recording */
  set(recordingId: string, metadata: MusicBrainzMetadata): void {
    this.db.setMetadata(recordingId, metadata);
  }

  /** Remove a recording from the cache */
  delete(recordingId: string): boolean {
    return this.db.deleteMetadata(recordingId);
  }

  /** Clear all cached results */
  clear(): void {
    this.db.clearMetadata();
  }

  /** Get the number of cached entries */
  get size(): number {
    return this.db.getMetadataCount();
  }
}

/**
 * Persistent lyrics cache that wraps PersistentCacheDatabase.
 * Compatible with the LyricsCache interface from lyricsFetcher.ts.
 */
export class PersistentLyricsCache implements ILyricsCache {
  private readonly db: PersistentCacheDatabase;

  constructor(db: PersistentCacheDatabase) {
    this.db = db;
  }

  /** Generate a normalized cache key from artist and title */
  static makeKey(artist: string, title: string): string {
    return PersistentCacheDatabase.makeLyricsKey(artist, title);
  }

  /** Check if lyrics for a song are cached */
  has(artist: string, title: string): boolean {
    return this.db.hasLyrics(artist, title);
  }

  /** Get cached lyrics for a song (returns undefined if not cached) */
  get(artist: string, title: string): CachedLyricsResult | null | undefined {
    return this.db.getLyrics(artist, title);
  }

  /** Store lyrics result for a song (null means "no lyrics found") */
  set(artist: string, title: string, result: CachedLyricsResult | null): void {
    this.db.setLyrics(artist, title, result);
  }

  /** Remove a song from the cache */
  delete(artist: string, title: string): boolean {
    return this.db.deleteLyrics(artist, title);
  }

  /** Clear all cached results */
  clear(): void {
    this.db.clearLyrics();
  }

  /** Get the number of cached entries */
  get size(): number {
    return this.db.getLyricsCount();
  }
}
