/**
 * Tests for Logger Service
 *
 * Comprehensive test suite covering:
 * - Helper functions (getDefaultLogDir, getLogFileName, formatLogEntry, parseLogLine, shouldLog)
 * - LogEntry creation (from PipelineError and from generic messages)
 * - Logger class (initialization, logging methods, retrieval, filtering, export, file I/O)
 * - File rotation
 * - PipelineError integration
 * - Edge cases and error handling
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Logger,
  LogEntry,
  LoggerOptions,
  getDefaultLogDir,
  getLogFileName,
  formatLogEntry,
  parseLogLine,
  shouldLog,
  createLogEntry,
  createLogEntryFromError,
} from '../../../src/main/services/logger';
import {
  PipelineError,
  FileReadError,
  FingerprintError,
  APIError,
  WriteError,
} from '../../../src/main/services/errors';

// ─── Test Helpers ────────────────────────────────────────────────────────

/** Creates a unique temp directory for each test */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
}

/** Removes a temp directory and its contents */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Fixed date for deterministic testing */
const FIXED_DATE = new Date('2025-02-17T14:30:00.000Z');
const getFixedDate = (): Date => new Date(FIXED_DATE.getTime());

/** Creates logger options for testing (no file write, fixed date) */
function testLoggerOptions(overrides?: Partial<LoggerOptions>): LoggerOptions {
  return {
    writeToFile: false,
    getCurrentDate: getFixedDate,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Logger Service', () => {
  // ─── getDefaultLogDir ─────────────────────────────────────────────

  describe('getDefaultLogDir', () => {
    it('should return a string path', () => {
      const dir = getDefaultLogDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });

    it('should contain "audio-pipeline" in the path', () => {
      const dir = getDefaultLogDir();
      expect(dir).toContain('audio-pipeline');
    });

    it('should contain "logs" in the path', () => {
      const dir = getDefaultLogDir();
      expect(dir).toContain('logs');
    });

    it('should end with the logs directory', () => {
      const dir = getDefaultLogDir();
      expect(dir.endsWith('logs')).toBe(true);
    });
  });

  // ─── getLogFileName ───────────────────────────────────────────────

  describe('getLogFileName', () => {
    it('should format date as YYYY-MM-DD.log', () => {
      const date = new Date('2025-02-17T10:00:00.000Z');
      expect(getLogFileName(date)).toBe('2025-02-17.log');
    });

    it('should zero-pad single-digit months', () => {
      const date = new Date('2025-03-05T10:00:00.000Z');
      expect(getLogFileName(date)).toBe('2025-03-05.log');
    });

    it('should zero-pad single-digit days', () => {
      const date = new Date('2025-01-03T10:00:00.000Z');
      expect(getLogFileName(date)).toBe('2025-01-03.log');
    });

    it('should handle December correctly', () => {
      // Create date using local constructor to avoid UTC-to-local timezone shift
      const date = new Date(2025, 11, 31, 12, 0, 0); // Month is 0-indexed: 11 = December
      expect(getLogFileName(date)).toBe('2025-12-31.log');
    });

    it('should handle January correctly', () => {
      // Create date using local constructor to avoid UTC-to-local timezone shift
      const date = new Date(2025, 0, 1, 12, 0, 0); // Month is 0-indexed: 0 = January
      expect(getLogFileName(date)).toBe('2025-01-01.log');
    });
  });

  // ─── formatLogEntry ───────────────────────────────────────────────

  describe('formatLogEntry', () => {
    it('should format a basic INFO entry', () => {
      const entry: LogEntry = {
        timestamp: '2025-02-17T14:30:00.000Z',
        level: 'INFO',
        message: 'Processing started',
        category: null,
        filePath: null,
        step: null,
        cause: null,
      };
      const result = formatLogEntry(entry);
      expect(result).toBe('[2025-02-17T14:30:00.000Z] INFO Processing started');
    });

    it('should include category when present', () => {
      const entry: LogEntry = {
        timestamp: '2025-02-17T14:30:00.000Z',
        level: 'ERROR',
        message: 'File not found',
        category: 'FileReadError',
        filePath: null,
        step: null,
        cause: null,
      };
      const result = formatLogEntry(entry);
      expect(result).toBe('[2025-02-17T14:30:00.000Z] ERROR [FileReadError] File not found');
    });

    it('should include filePath when present', () => {
      const entry: LogEntry = {
        timestamp: '2025-02-17T14:30:00.000Z',
        level: 'ERROR',
        message: 'Read failed',
        category: 'FileReadError',
        filePath: '/music/song.mp3',
        step: null,
        cause: null,
      };
      const result = formatLogEntry(entry);
      expect(result).toContain('| filePath: /music/song.mp3');
    });

    it('should include step when present', () => {
      const entry: LogEntry = {
        timestamp: '2025-02-17T14:30:00.000Z',
        level: 'WARN',
        message: 'Skipped file',
        category: null,
        filePath: null,
        step: 'fingerprinting',
        cause: null,
      };
      const result = formatLogEntry(entry);
      expect(result).toContain('| step: fingerprinting');
    });

    it('should include cause when present', () => {
      const entry: LogEntry = {
        timestamp: '2025-02-17T14:30:00.000Z',
        level: 'ERROR',
        message: 'API call failed',
        category: 'APIError',
        filePath: null,
        step: null,
        cause: 'Connection timeout',
      };
      const result = formatLogEntry(entry);
      expect(result).toContain('| cause: Connection timeout');
    });

    it('should include all fields in correct order', () => {
      const entry: LogEntry = {
        timestamp: '2025-02-17T14:30:00.000Z',
        level: 'ERROR',
        message: 'Write failed',
        category: 'WriteError',
        filePath: '/music/song.mp3',
        step: 'writing',
        cause: 'Permission denied',
      };
      const result = formatLogEntry(entry);
      expect(result).toBe(
        '[2025-02-17T14:30:00.000Z] ERROR [WriteError] Write failed | filePath: /music/song.mp3 | step: writing | cause: Permission denied',
      );
    });
  });

  // ─── parseLogLine ─────────────────────────────────────────────────

  describe('parseLogLine', () => {
    it('should parse a basic INFO line', () => {
      const line = '[2025-02-17T14:30:00.000Z] INFO Processing started';
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.timestamp).toBe('2025-02-17T14:30:00.000Z');
      expect(parsed!.level).toBe('INFO');
      expect(parsed!.message).toBe('Processing started');
      expect(parsed!.category).toBeNull();
    });

    it('should parse an ERROR line with category', () => {
      const line = '[2025-02-17T14:30:00.000Z] ERROR [FileReadError] File not found';
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.level).toBe('ERROR');
      expect(parsed!.category).toBe('FileReadError');
      expect(parsed!.message).toBe('File not found');
    });

    it('should parse a line with filePath', () => {
      const line =
        '[2025-02-17T14:30:00.000Z] ERROR [FileReadError] Read failed | filePath: /music/song.mp3';
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.filePath).toBe('/music/song.mp3');
    });

    it('should parse a line with all fields', () => {
      const line =
        '[2025-02-17T14:30:00.000Z] ERROR [WriteError] Write failed | filePath: /music/song.mp3 | step: writing | cause: Permission denied';
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.level).toBe('ERROR');
      expect(parsed!.category).toBe('WriteError');
      expect(parsed!.filePath).toBe('/music/song.mp3');
      expect(parsed!.step).toBe('writing');
      expect(parsed!.cause).toBe('Permission denied');
    });

    it('should return null for empty string', () => {
      expect(parseLogLine('')).toBeNull();
    });

    it('should return null for whitespace-only string', () => {
      expect(parseLogLine('   \t  ')).toBeNull();
    });

    it('should return null for unparseable lines', () => {
      expect(parseLogLine('random text without proper format')).toBeNull();
    });

    it('should parse a WARN line', () => {
      const line = '[2025-02-17T14:30:00.000Z] WARN File skipped: unidentifiable';
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.level).toBe('WARN');
      expect(parsed!.message).toBe('File skipped: unidentifiable');
    });

    it('should roundtrip with formatLogEntry', () => {
      const entry: LogEntry = {
        timestamp: '2025-02-17T14:30:00.000Z',
        level: 'ERROR',
        message: 'Test error',
        category: 'APIError',
        filePath: '/music/test.mp3',
        step: 'api_call',
        cause: 'Timeout',
      };
      const formatted = formatLogEntry(entry);
      const parsed = parseLogLine(formatted);
      expect(parsed).not.toBeNull();
      expect(parsed!.timestamp).toBe(entry.timestamp);
      expect(parsed!.level).toBe(entry.level);
      expect(parsed!.category).toBe(entry.category);
      expect(parsed!.filePath).toBe(entry.filePath);
      expect(parsed!.step).toBe(entry.step);
      expect(parsed!.cause).toBe(entry.cause);
    });
  });

  // ─── shouldLog ────────────────────────────────────────────────────

  describe('shouldLog', () => {
    it('should allow ERROR when minLevel is ERROR', () => {
      expect(shouldLog('ERROR', 'ERROR')).toBe(true);
    });

    it('should not allow WARN when minLevel is ERROR', () => {
      expect(shouldLog('WARN', 'ERROR')).toBe(false);
    });

    it('should not allow INFO when minLevel is ERROR', () => {
      expect(shouldLog('INFO', 'ERROR')).toBe(false);
    });

    it('should allow ERROR when minLevel is WARN', () => {
      expect(shouldLog('ERROR', 'WARN')).toBe(true);
    });

    it('should allow WARN when minLevel is WARN', () => {
      expect(shouldLog('WARN', 'WARN')).toBe(true);
    });

    it('should not allow INFO when minLevel is WARN', () => {
      expect(shouldLog('INFO', 'WARN')).toBe(false);
    });

    it('should allow all levels when minLevel is INFO', () => {
      expect(shouldLog('ERROR', 'INFO')).toBe(true);
      expect(shouldLog('WARN', 'INFO')).toBe(true);
      expect(shouldLog('INFO', 'INFO')).toBe(true);
    });
  });

  // ─── createLogEntry ───────────────────────────────────────────────

  describe('createLogEntry', () => {
    it('should create a basic log entry', () => {
      const entry = createLogEntry('INFO', 'Test message', undefined, getFixedDate);
      expect(entry.timestamp).toBe('2025-02-17T14:30:00.000Z');
      expect(entry.level).toBe('INFO');
      expect(entry.message).toBe('Test message');
      expect(entry.category).toBeNull();
      expect(entry.filePath).toBeNull();
      expect(entry.step).toBeNull();
      expect(entry.cause).toBeNull();
    });

    it('should include optional fields when provided', () => {
      const entry = createLogEntry(
        'ERROR',
        'Read failed',
        {
          category: 'FileReadError',
          filePath: '/music/song.mp3',
          step: 'reading',
          cause: 'ENOENT',
        },
        getFixedDate,
      );
      expect(entry.category).toBe('FileReadError');
      expect(entry.filePath).toBe('/music/song.mp3');
      expect(entry.step).toBe('reading');
      expect(entry.cause).toBe('ENOENT');
    });

    it('should use current date when no getCurrentDate provided', () => {
      const before = new Date();
      const entry = createLogEntry('INFO', 'test');
      const after = new Date();
      const entryDate = new Date(entry.timestamp);
      expect(entryDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(entryDate.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  // ─── createLogEntryFromError ──────────────────────────────────────

  describe('createLogEntryFromError', () => {
    it('should create entry from FileReadError', () => {
      const error = new FileReadError('File not found', {
        filePath: '/music/song.mp3',
        cause: new Error('ENOENT'),
      });
      const entry = createLogEntryFromError(error, 'ERROR', getFixedDate);
      expect(entry.level).toBe('ERROR');
      expect(entry.message).toBe('File not found');
      expect(entry.category).toBe('FileReadError');
      expect(entry.filePath).toBe('/music/song.mp3');
      expect(entry.step).toBe('reading');
      expect(entry.cause).toBe('ENOENT');
    });

    it('should create entry from FingerprintError', () => {
      const error = new FingerprintError('fpcalc not found', {
        filePath: '/music/song.mp3',
      });
      const entry = createLogEntryFromError(error, 'ERROR', getFixedDate);
      expect(entry.category).toBe('FingerprintError');
      expect(entry.step).toBe('fingerprinting');
      expect(entry.cause).toBeNull();
    });

    it('should create entry from APIError', () => {
      const error = new APIError('MusicBrainz timeout', {
        service: 'MusicBrainz',
        statusCode: 503,
      });
      const entry = createLogEntryFromError(error, 'ERROR', getFixedDate);
      expect(entry.category).toBe('APIError');
      expect(entry.step).toBe('api_call');
    });

    it('should create entry from WriteError', () => {
      const error = new WriteError('Permission denied', {
        filePath: '/music/song.mp3',
        step: 'tag_writing',
      });
      const entry = createLogEntryFromError(error, 'ERROR', getFixedDate);
      expect(entry.category).toBe('WriteError');
      expect(entry.step).toBe('tag_writing');
    });

    it('should default to ERROR level', () => {
      const error = new PipelineError('test', 'FileReadError');
      const entry = createLogEntryFromError(error);
      expect(entry.level).toBe('ERROR');
    });

    it('should allow custom log level', () => {
      const error = new PipelineError('test', 'FileReadError');
      const entry = createLogEntryFromError(error, 'WARN', getFixedDate);
      expect(entry.level).toBe('WARN');
    });
  });

  // ─── Logger Class ─────────────────────────────────────────────────

  describe('Logger', () => {
    let logger: Logger;

    beforeEach(() => {
      logger = new Logger(testLoggerOptions());
    });

    // ─── Constructor and Initialization ─────────────────────────

    describe('constructor', () => {
      it('should create a logger with default options', () => {
        const defaultLogger = new Logger();
        expect(defaultLogger.getLogDir()).toBe(getDefaultLogDir());
        expect(defaultLogger.isInitialized()).toBe(false);
      });

      it('should accept custom options', () => {
        const customLogger = new Logger({
          logDir: '/custom/logs',
          minLevel: 'WARN',
          writeToFile: false,
        });
        expect(customLogger.getLogDir()).toBe('/custom/logs');
      });

      it('should start with zero entries', () => {
        expect(logger.size).toBe(0);
      });
    });

    describe('initialize', () => {
      it('should set initialized to true for in-memory logger', async () => {
        await logger.initialize();
        expect(logger.isInitialized()).toBe(true);
      });

      it('should create log directory when writeToFile is true', async () => {
        const tempDir = createTempDir();
        const logDir = path.join(tempDir, 'test-logs');

        try {
          const fileLogger = new Logger({
            logDir,
            writeToFile: true,
            getCurrentDate: getFixedDate,
          });
          await fileLogger.initialize();
          expect(fileLogger.isInitialized()).toBe(true);
          expect(fs.existsSync(logDir)).toBe(true);
        } finally {
          removeTempDir(tempDir);
        }
      });

      it('should handle failed directory creation gracefully', async () => {
        // Use an invalid path that can't be created
        const invalidLogger = new Logger({
          logDir: path.join('\0invalid', 'path'),
          writeToFile: true,
          getCurrentDate: getFixedDate,
        });
        await invalidLogger.initialize();
        // Should still be initialized (with a warning entry)
        expect(invalidLogger.isInitialized()).toBe(true);
        expect(invalidLogger.size).toBeGreaterThan(0);
      });
    });

    // ─── Logging Methods ────────────────────────────────────────

    describe('error', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should log an ERROR entry', () => {
        logger.error('Something failed');
        const entries = logger.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('ERROR');
        expect(entries[0].message).toBe('Something failed');
      });

      it('should include context options', () => {
        logger.error('Read failed', {
          category: 'FileReadError',
          filePath: '/music/song.mp3',
          step: 'reading',
          cause: 'ENOENT',
        });
        const entry = logger.getEntries()[0];
        expect(entry.category).toBe('FileReadError');
        expect(entry.filePath).toBe('/music/song.mp3');
        expect(entry.step).toBe('reading');
        expect(entry.cause).toBe('ENOENT');
      });
    });

    describe('warn', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should log a WARN entry', () => {
        logger.warn('File might be corrupt');
        const entries = logger.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('WARN');
        expect(entries[0].message).toBe('File might be corrupt');
      });
    });

    describe('info', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should log an INFO entry', () => {
        logger.info('Processing started');
        const entries = logger.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('INFO');
        expect(entries[0].message).toBe('Processing started');
      });
    });

    describe('minLevel filtering', () => {
      it('should not log INFO when minLevel is ERROR', async () => {
        const errorOnlyLogger = new Logger(testLoggerOptions({ minLevel: 'ERROR' }));
        await errorOnlyLogger.initialize();
        errorOnlyLogger.info('This should be ignored');
        errorOnlyLogger.warn('This too');
        errorOnlyLogger.error('This should appear');
        expect(errorOnlyLogger.size).toBe(1);
        expect(errorOnlyLogger.getEntries()[0].level).toBe('ERROR');
      });

      it('should log WARN and ERROR when minLevel is WARN', async () => {
        const warnLogger = new Logger(testLoggerOptions({ minLevel: 'WARN' }));
        await warnLogger.initialize();
        warnLogger.info('This should be ignored');
        warnLogger.warn('This should appear');
        warnLogger.error('This should appear');
        expect(warnLogger.size).toBe(2);
      });

      it('should log all levels when minLevel is INFO', async () => {
        await logger.initialize();
        logger.info('info');
        logger.warn('warn');
        logger.error('error');
        expect(logger.size).toBe(3);
      });
    });

    // ─── PipelineError Integration ──────────────────────────────

    describe('logPipelineError', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should log a FileReadError', () => {
        const error = new FileReadError('File not found', {
          filePath: '/music/song.mp3',
          cause: new Error('ENOENT'),
        });
        logger.logPipelineError(error);
        const entries = logger.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('ERROR');
        expect(entries[0].category).toBe('FileReadError');
        expect(entries[0].filePath).toBe('/music/song.mp3');
        expect(entries[0].cause).toBe('ENOENT');
      });

      it('should log a FingerprintError', () => {
        const error = new FingerprintError('fpcalc timeout');
        logger.logPipelineError(error);
        const entry = logger.getEntries()[0];
        expect(entry.category).toBe('FingerprintError');
      });

      it('should log an APIError', () => {
        const error = new APIError('Service unavailable', {
          service: 'MusicBrainz',
          statusCode: 503,
        });
        logger.logPipelineError(error);
        const entry = logger.getEntries()[0];
        expect(entry.category).toBe('APIError');
      });

      it('should log a WriteError', () => {
        const error = new WriteError('Permission denied', {
          filePath: '/music/song.mp3',
        });
        logger.logPipelineError(error);
        const entry = logger.getEntries()[0];
        expect(entry.category).toBe('WriteError');
      });

      it('should allow custom log level', () => {
        const error = new FileReadError('warning scenario');
        logger.logPipelineError(error, 'WARN');
        const entry = logger.getEntries()[0];
        expect(entry.level).toBe('WARN');
      });
    });

    describe('logError', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should handle PipelineError instances', () => {
        const error = new FileReadError('File not found', {
          filePath: '/music/song.mp3',
        });
        logger.logError(error);
        const entry = logger.getEntries()[0];
        expect(entry.category).toBe('FileReadError');
        expect(entry.filePath).toBe('/music/song.mp3');
      });

      it('should handle generic Error instances', () => {
        const error = new Error('Something went wrong');
        logger.logError(error, { filePath: '/music/song.mp3', step: 'reading' });
        const entry = logger.getEntries()[0];
        expect(entry.level).toBe('ERROR');
        expect(entry.message).toBe('Something went wrong');
        expect(entry.filePath).toBe('/music/song.mp3');
        expect(entry.step).toBe('reading');
      });

      it('should handle string errors', () => {
        logger.logError('string error');
        const entry = logger.getEntries()[0];
        expect(entry.message).toBe('string error');
      });

      it('should handle non-Error objects', () => {
        logger.logError({ code: 42 });
        const entry = logger.getEntries()[0];
        expect(entry.level).toBe('ERROR');
      });
    });

    describe('logSkippedFile', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should log a WARN entry for skipped files', () => {
        logger.logSkippedFile('/music/unknown.mp3', 'Unidentifiable');
        const entry = logger.getEntries()[0];
        expect(entry.level).toBe('WARN');
        expect(entry.message).toContain('File skipped');
        expect(entry.message).toContain('Unidentifiable');
        expect(entry.filePath).toBe('/music/unknown.mp3');
        expect(entry.step).toBe('processing');
      });
    });

    // ─── Retrieval Methods ──────────────────────────────────────

    describe('getEntries', () => {
      beforeEach(async () => {
        await logger.initialize();
        logger.info('Info message');
        logger.warn('Warning message');
        logger.error('Error message', { category: 'FileReadError', filePath: '/a.mp3' });
        logger.error('Another error', { category: 'APIError', filePath: '/b.mp3' });
      });

      it('should return all entries when no filter', () => {
        expect(logger.getEntries()).toHaveLength(4);
      });

      it('should filter by level', () => {
        const errors = logger.getEntries({ level: 'ERROR' });
        expect(errors).toHaveLength(2);
        expect(errors.every((e) => e.level === 'ERROR')).toBe(true);
      });

      it('should filter by category', () => {
        const apiErrors = logger.getEntries({ category: 'APIError' });
        expect(apiErrors).toHaveLength(1);
        expect(apiErrors[0].category).toBe('APIError');
      });

      it('should filter by filePath (substring, case-insensitive)', () => {
        const entries = logger.getEntries({ filePath: '/A.MP3' });
        expect(entries).toHaveLength(1);
        expect(entries[0].filePath).toBe('/a.mp3');
      });

      it('should limit results', () => {
        const entries = logger.getEntries({ limit: 2 });
        expect(entries).toHaveLength(2);
      });

      it('should return last N entries when limited', () => {
        const entries = logger.getEntries({ limit: 1 });
        expect(entries[0].category).toBe('APIError');
      });

      it('should combine multiple filters', () => {
        const entries = logger.getEntries({ level: 'ERROR', category: 'FileReadError' });
        expect(entries).toHaveLength(1);
        expect(entries[0].message).toBe('Error message');
      });

      it('should return empty array when no matches', () => {
        const entries = logger.getEntries({ category: 'WriteError' });
        expect(entries).toHaveLength(0);
      });
    });

    describe('getErrors', () => {
      beforeEach(async () => {
        await logger.initialize();
        logger.info('Info');
        logger.warn('Warn');
        logger.error('Error 1');
        logger.error('Error 2');
      });

      it('should return only ERROR entries', () => {
        const errors = logger.getErrors();
        expect(errors).toHaveLength(2);
        expect(errors.every((e) => e.level === 'ERROR')).toBe(true);
      });

      it('should respect limit parameter', () => {
        const errors = logger.getErrors(1);
        expect(errors).toHaveLength(1);
      });
    });

    describe('getWarnings', () => {
      beforeEach(async () => {
        await logger.initialize();
        logger.info('Info');
        logger.warn('Warn 1');
        logger.warn('Warn 2');
        logger.error('Error');
      });

      it('should return only WARN entries', () => {
        const warnings = logger.getWarnings();
        expect(warnings).toHaveLength(2);
        expect(warnings.every((e) => e.level === 'WARN')).toBe(true);
      });

      it('should respect limit parameter', () => {
        const warnings = logger.getWarnings(1);
        expect(warnings).toHaveLength(1);
      });
    });

    // ─── Summary ────────────────────────────────────────────────

    describe('getSummary', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should return correct counts for empty log', () => {
        const summary = logger.getSummary();
        expect(summary.totalEntries).toBe(0);
        expect(summary.errorCount).toBe(0);
        expect(summary.warnCount).toBe(0);
        expect(summary.infoCount).toBe(0);
      });

      it('should count entries by level', () => {
        logger.info('Info 1');
        logger.info('Info 2');
        logger.warn('Warn');
        logger.error('Error');
        const summary = logger.getSummary();
        expect(summary.totalEntries).toBe(4);
        expect(summary.errorCount).toBe(1);
        expect(summary.warnCount).toBe(1);
        expect(summary.infoCount).toBe(2);
      });

      it('should breakdown errors by category', () => {
        logger.error('Read error 1', { category: 'FileReadError' });
        logger.error('Read error 2', { category: 'FileReadError' });
        logger.error('API error', { category: 'APIError' });
        logger.error('Write error', { category: 'WriteError' });
        const summary = logger.getSummary();
        expect(summary.errorsByCategory['FileReadError']).toBe(2);
        expect(summary.errorsByCategory['APIError']).toBe(1);
        expect(summary.errorsByCategory['WriteError']).toBe(1);
      });

      it('should return null logFilePath when writeToFile is false', () => {
        const summary = logger.getSummary();
        expect(summary.logFilePath).toBeNull();
      });

      it('should return logFilePath when writeToFile is true', async () => {
        const tempDir = createTempDir();
        try {
          const fileLogger = new Logger({
            logDir: tempDir,
            writeToFile: true,
            getCurrentDate: getFixedDate,
          });
          await fileLogger.initialize();
          const summary = fileLogger.getSummary();
          expect(summary.logFilePath).toBe(path.join(tempDir, '2025-02-17.log'));
        } finally {
          removeTempDir(tempDir);
        }
      });
    });

    // ─── Clear ──────────────────────────────────────────────────

    describe('clear', () => {
      beforeEach(async () => {
        await logger.initialize();
      });

      it('should clear all in-memory entries', () => {
        logger.info('Info');
        logger.error('Error');
        expect(logger.size).toBe(2);
        logger.clear();
        expect(logger.size).toBe(0);
        expect(logger.getEntries()).toHaveLength(0);
      });
    });

    // ─── File I/O ───────────────────────────────────────────────

    describe('file I/O', () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = createTempDir();
      });

      afterEach(() => {
        removeTempDir(tempDir);
      });

      it('should write log entries to file', async () => {
        const logDir = path.join(tempDir, 'logs');
        const fileLogger = new Logger({
          logDir,
          writeToFile: true,
          getCurrentDate: getFixedDate,
        });
        await fileLogger.initialize();

        fileLogger.info('Test message');
        fileLogger.error('Error message', { category: 'FileReadError' });

        const logFile = path.join(logDir, '2025-02-17.log');
        expect(fs.existsSync(logFile)).toBe(true);

        const content = fs.readFileSync(logFile, 'utf-8');
        expect(content).toContain('Test message');
        expect(content).toContain('Error message');
        expect(content).toContain('FileReadError');
      });

      it('should append to existing log file', async () => {
        const logDir = path.join(tempDir, 'logs');
        const fileLogger = new Logger({
          logDir,
          writeToFile: true,
          getCurrentDate: getFixedDate,
        });
        await fileLogger.initialize();

        fileLogger.info('First message');
        fileLogger.info('Second message');

        const logFile = path.join(logDir, '2025-02-17.log');
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(2);
      });

      it('should handle getLogFilePath correctly', () => {
        const logDir = path.join(tempDir, 'logs');
        const fileLogger = new Logger({
          logDir,
          writeToFile: true,
          getCurrentDate: getFixedDate,
        });
        expect(fileLogger.getLogFilePath()).toBe(path.join(logDir, '2025-02-17.log'));
      });
    });

    // ─── Log File Rotation ──────────────────────────────────────

    describe('log file rotation', () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = createTempDir();
      });

      afterEach(() => {
        removeTempDir(tempDir);
      });

      it('should rotate log file when it exceeds maxFileSize', async () => {
        const logDir = path.join(tempDir, 'logs');
        const fileLogger = new Logger({
          logDir,
          writeToFile: true,
          maxFileSize: 100, // 100 bytes - will rotate quickly
          getCurrentDate: getFixedDate,
        });
        await fileLogger.initialize();

        // Write enough entries to exceed 100 bytes
        fileLogger.info('This is a fairly long log message that should take up space');
        fileLogger.info('Another long log message to trigger rotation mechanism now');
        fileLogger.info('Third message after rotation');

        const logFile = path.join(logDir, '2025-02-17.log');
        const rotatedFile = path.join(logDir, '2025-02-17.1.log');

        expect(fs.existsSync(logFile)).toBe(true);
        expect(fs.existsSync(rotatedFile)).toBe(true);
      });

      it('should increment rotation index for multiple rotations', async () => {
        const logDir = path.join(tempDir, 'logs');
        const fileLogger = new Logger({
          logDir,
          writeToFile: true,
          maxFileSize: 50, // Very small to trigger multiple rotations
          getCurrentDate: getFixedDate,
        });
        await fileLogger.initialize();

        // Write many entries to trigger multiple rotations
        for (let i = 0; i < 10; i++) {
          fileLogger.info(`Long message number ${i} for rotation testing purposes`);
        }

        const logFile = path.join(logDir, '2025-02-17.log');
        expect(fs.existsSync(logFile)).toBe(true);

        // At least one rotation file should exist
        const rotatedFile1 = path.join(logDir, '2025-02-17.1.log');
        expect(fs.existsSync(rotatedFile1)).toBe(true);
      });
    });

    // ─── Export Methods ─────────────────────────────────────────

    describe('exportLog', () => {
      let tempDir: string;

      beforeEach(async () => {
        tempDir = createTempDir();
        await logger.initialize();
      });

      afterEach(() => {
        removeTempDir(tempDir);
      });

      it('should export log entries to a file', async () => {
        logger.info('Info message');
        logger.error('Error message', { category: 'FileReadError' });

        const exportPath = path.join(tempDir, 'exported.log');
        const result = await logger.exportLog(exportPath);
        expect(result).toBe(true);
        expect(fs.existsSync(exportPath)).toBe(true);

        const content = fs.readFileSync(exportPath, 'utf-8');
        expect(content).toContain('Info message');
        expect(content).toContain('Error message');
      });

      it('should create parent directories for export path', async () => {
        logger.info('Test');

        const exportPath = path.join(tempDir, 'sub', 'dir', 'exported.log');
        const result = await logger.exportLog(exportPath);
        expect(result).toBe(true);
        expect(fs.existsSync(exportPath)).toBe(true);
      });

      it('should export empty file when no entries', async () => {
        const exportPath = path.join(tempDir, 'empty.log');
        const result = await logger.exportLog(exportPath);
        expect(result).toBe(true);
        const content = fs.readFileSync(exportPath, 'utf-8');
        expect(content).toBe('');
      });

      it('should return false on export failure', async () => {
        logger.info('Test');
        // Try to export to an invalid path
        const result = await logger.exportLog(path.join('\0invalid', 'path'));
        expect(result).toBe(false);
      });
    });

    describe('readLogFile', () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = createTempDir();
      });

      afterEach(() => {
        removeTempDir(tempDir);
      });

      it('should read and parse a log file', async () => {
        const logDir = path.join(tempDir, 'logs');
        const fileLogger = new Logger({
          logDir,
          writeToFile: true,
          getCurrentDate: getFixedDate,
        });
        await fileLogger.initialize();

        fileLogger.info('Info message');
        fileLogger.error('Error message', { category: 'FileReadError' });

        const entries = await fileLogger.readLogFile();
        expect(entries).toHaveLength(2);
        expect(entries[0].level).toBe('INFO');
        expect(entries[1].level).toBe('ERROR');
        expect(entries[1].category).toBe('FileReadError');
      });

      it('should read a specific log file path', async () => {
        const logFile = path.join(tempDir, 'custom.log');
        const content =
          '[2025-02-17T14:30:00.000Z] INFO Test message\n[2025-02-17T14:31:00.000Z] ERROR [APIError] API failed\n';
        fs.writeFileSync(logFile, content, 'utf-8');

        const entries = await logger.readLogFile(logFile);
        expect(entries).toHaveLength(2);
        expect(entries[0].message).toBe('Test message');
        expect(entries[1].category).toBe('APIError');
      });

      it('should return empty array for non-existent file', async () => {
        const entries = await logger.readLogFile('/nonexistent/file.log');
        expect(entries).toHaveLength(0);
      });

      it('should skip unparseable lines', async () => {
        const logFile = path.join(tempDir, 'mixed.log');
        const content =
          '[2025-02-17T14:30:00.000Z] INFO Good line\nBad line here\n\n[2025-02-17T14:31:00.000Z] ERROR Another good line\n';
        fs.writeFileSync(logFile, content, 'utf-8');

        const entries = await logger.readLogFile(logFile);
        expect(entries).toHaveLength(2);
      });
    });

    describe('listLogFiles', () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = createTempDir();
      });

      afterEach(() => {
        removeTempDir(tempDir);
      });

      it('should list log files sorted newest first', async () => {
        const logDir = path.join(tempDir, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(path.join(logDir, '2025-02-15.log'), 'old', 'utf-8');
        fs.writeFileSync(path.join(logDir, '2025-02-17.log'), 'new', 'utf-8');
        fs.writeFileSync(path.join(logDir, '2025-02-16.log'), 'mid', 'utf-8');

        const listLogger = new Logger({ logDir, writeToFile: false });
        const files = await listLogger.listLogFiles();
        expect(files).toHaveLength(3);
        expect(files[0]).toContain('2025-02-17.log');
        expect(files[1]).toContain('2025-02-16.log');
        expect(files[2]).toContain('2025-02-15.log');
      });

      it('should only list .log files', async () => {
        const logDir = path.join(tempDir, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(path.join(logDir, '2025-02-17.log'), 'log', 'utf-8');
        fs.writeFileSync(path.join(logDir, 'readme.txt'), 'text', 'utf-8');
        fs.writeFileSync(path.join(logDir, 'data.json'), '{}', 'utf-8');

        const listLogger = new Logger({ logDir, writeToFile: false });
        const files = await listLogger.listLogFiles();
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('2025-02-17.log');
      });

      it('should return empty array for non-existent directory', async () => {
        const listLogger = new Logger({
          logDir: '/nonexistent/dir',
          writeToFile: false,
        });
        const files = await listLogger.listLogFiles();
        expect(files).toHaveLength(0);
      });
    });

    // ─── Integration Tests ──────────────────────────────────────

    describe('Integration', () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = createTempDir();
      });

      afterEach(() => {
        removeTempDir(tempDir);
      });

      it('should handle a full processing session lifecycle', async () => {
        const logDir = path.join(tempDir, 'logs');
        const sessionLogger = new Logger({
          logDir,
          writeToFile: true,
          getCurrentDate: getFixedDate,
        });
        await sessionLogger.initialize();

        // Simulate processing
        sessionLogger.info('Processing started: 3 files');
        sessionLogger.info('Processing file 1/3', { filePath: '/music/song1.mp3' });
        sessionLogger.info('Successfully processed', { filePath: '/music/song1.mp3' });

        sessionLogger.info('Processing file 2/3', { filePath: '/music/song2.mp3' });
        sessionLogger.logPipelineError(
          new FileReadError('Corrupt file', { filePath: '/music/song2.mp3' }),
        );

        sessionLogger.info('Processing file 3/3', { filePath: '/music/song3.mp3' });
        sessionLogger.logSkippedFile('/music/song3.mp3', 'No fingerprint match');

        sessionLogger.info('Processing complete: 1 success, 1 error, 1 skipped');

        // Verify summary
        const summary = sessionLogger.getSummary();
        expect(summary.totalEntries).toBe(8);
        expect(summary.errorCount).toBe(1);
        expect(summary.warnCount).toBe(1);
        expect(summary.infoCount).toBe(6);
        expect(summary.errorsByCategory['FileReadError']).toBe(1);

        // Verify file was written
        const logFile = path.join(logDir, '2025-02-17.log');
        expect(fs.existsSync(logFile)).toBe(true);

        // Verify file can be read back
        const fileEntries = await sessionLogger.readLogFile();
        expect(fileEntries).toHaveLength(8);

        // Verify export works
        const exportPath = path.join(tempDir, 'export', 'session.log');
        const exported = await sessionLogger.exportLog(exportPath);
        expect(exported).toBe(true);
      });

      it('should handle all PipelineError types in a session', async () => {
        await logger.initialize();

        const errors = [
          new FileReadError('File not found', { filePath: '/a.mp3' }),
          new FingerprintError('fpcalc timeout', { filePath: '/b.mp3' }),
          new APIError('MusicBrainz 503', { service: 'MusicBrainz', statusCode: 503 }),
          new WriteError('Disk full', { filePath: '/c.mp3' }),
        ];

        for (const error of errors) {
          logger.logPipelineError(error);
        }

        const summary = logger.getSummary();
        expect(summary.errorCount).toBe(4);
        expect(summary.errorsByCategory['FileReadError']).toBe(1);
        expect(summary.errorsByCategory['FingerprintError']).toBe(1);
        expect(summary.errorsByCategory['APIError']).toBe(1);
        expect(summary.errorsByCategory['WriteError']).toBe(1);
      });

      it('should handle mixed logError calls with different error types', async () => {
        await logger.initialize();

        logger.logError(new FileReadError('Pipeline error'), { filePath: '/a.mp3' });
        logger.logError(new Error('Generic error'), { filePath: '/b.mp3' });
        logger.logError('String error', { filePath: '/c.mp3' });
        logger.logError(42);

        expect(logger.size).toBe(4);
        expect(logger.getErrors()).toHaveLength(4);
      });

      it('should support filtering skipped files', async () => {
        await logger.initialize();

        logger.logSkippedFile('/a.mp3', 'No match');
        logger.logSkippedFile('/b.mp3', 'Corrupt');
        logger.info('Normal info');
        logger.error('Normal error');

        const warnings = logger.getWarnings();
        expect(warnings).toHaveLength(2);
        expect(warnings[0].message).toContain('No match');
        expect(warnings[1].message).toContain('Corrupt');
      });
    });
  });
});
