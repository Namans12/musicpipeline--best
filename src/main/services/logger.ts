/**
 * Logger Service for Audio Pipeline
 *
 * Provides structured logging with file output, log levels, error categorization,
 * and integration with PipelineError classes. Supports daily log file rotation,
 * configurable log directory, and both file and in-memory log retrieval.
 *
 * Log levels: ERROR (processing failures), WARN (skipped files), INFO (progress)
 *
 * Default log directory: %APPDATA%/audio-pipeline/logs/
 * Log file format: YYYY-MM-DD.log
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PipelineError, isPipelineError, ErrorCategory } from './errors';

// ─── Interfaces ──────────────────────────────────────────────────────────

/** Log severity levels */
export type LogLevel = 'ERROR' | 'WARN' | 'INFO';

/** A single log entry */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log severity level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Error category (if applicable) */
  category: ErrorCategory | null;
  /** File being processed when the log was created (if applicable) */
  filePath: string | null;
  /** Processing step where the log was created (if applicable) */
  step: string | null;
  /** Original error message (from cause chain, if applicable) */
  cause: string | null;
}

/** Options for configuring the Logger */
export interface LoggerOptions {
  /** Directory to store log files. Defaults to %APPDATA%/audio-pipeline/logs/ */
  logDir?: string;
  /** Minimum log level to write (inclusive). Defaults to 'INFO' */
  minLevel?: LogLevel;
  /** Whether to write to file. Defaults to true */
  writeToFile?: boolean;
  /** Maximum log file size in bytes before rotation. Defaults to 10MB */
  maxFileSize?: number;
  /** Custom function to get the current date (for testing) */
  getCurrentDate?: () => Date;
}

/** Summary of log entries for display */
export interface LogSummary {
  /** Total number of log entries */
  totalEntries: number;
  /** Number of ERROR entries */
  errorCount: number;
  /** Number of WARN entries */
  warnCount: number;
  /** Number of INFO entries */
  infoCount: number;
  /** Breakdown of errors by category */
  errorsByCategory: Record<string, number>;
  /** Log file path (if file logging is enabled) */
  logFilePath: string | null;
}

/** Filter options for retrieving log entries */
export interface LogFilter {
  /** Filter by log level */
  level?: LogLevel;
  /** Filter by error category */
  category?: ErrorCategory;
  /** Filter by file path (substring match) */
  filePath?: string;
  /** Maximum number of entries to return */
  limit?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

/** Default app data directory name */
const APP_DIR_NAME = 'audio-pipeline';

/** Default log subdirectory */
const LOG_DIR_NAME = 'logs';

/** Default maximum log file size (10MB) */
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Log level numeric values for comparison */
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
};

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Returns the default log directory path based on the platform.
 * On Windows: %APPDATA%/audio-pipeline/logs/
 * On other platforms: ~/.audio-pipeline/logs/
 */
export function getDefaultLogDir(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(appData, APP_DIR_NAME, LOG_DIR_NAME);
}

/**
 * Generates a log filename from a Date object.
 * Format: YYYY-MM-DD.log
 *
 * @param date - The date to generate the filename for
 * @returns The log filename string
 */
export function getLogFileName(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}.log`;
}

/**
 * Formats a LogEntry as a single-line string for file output.
 * Format: [TIMESTAMP] LEVEL [CATEGORY] message | filePath: ... | step: ... | cause: ...
 *
 * @param entry - The log entry to format
 * @returns The formatted string
 */
export function formatLogEntry(entry: LogEntry): string {
  const parts: string[] = [];

  parts.push(`[${entry.timestamp}]`);
  parts.push(entry.level);

  if (entry.category) {
    parts.push(`[${entry.category}]`);
  }

  parts.push(entry.message);

  if (entry.filePath) {
    parts.push(`| filePath: ${entry.filePath}`);
  }

  if (entry.step) {
    parts.push(`| step: ${entry.step}`);
  }

  if (entry.cause) {
    parts.push(`| cause: ${entry.cause}`);
  }

  return parts.join(' ');
}

/**
 * Parses a formatted log line back into a LogEntry object.
 * Best-effort parsing: returns null for lines that can't be parsed.
 *
 * @param line - A single log file line
 * @returns Parsed LogEntry or null if unparseable
 */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Match [timestamp] LEVEL [Category] message...
  const mainMatch = trimmed.match(/^\[([^\]]+)\]\s+(ERROR|WARN|INFO)\s+(?:\[([^\]]+)\]\s+)?(.*)$/);

  if (!mainMatch) return null;

  const timestamp = mainMatch[1];
  const level = mainMatch[2] as LogLevel;
  const category = (mainMatch[3] as ErrorCategory) || null;
  let rest = mainMatch[4];

  // Extract optional pipe-separated fields
  let filePath: string | null = null;
  let step: string | null = null;
  let cause: string | null = null;

  const filePathMatch = rest.match(/\|\s*filePath:\s*(.+?)(?=\s*\||$)/);
  if (filePathMatch) {
    filePath = filePathMatch[1].trim();
    rest = rest.replace(filePathMatch[0], '');
  }

  const stepMatch = rest.match(/\|\s*step:\s*(.+?)(?=\s*\||$)/);
  if (stepMatch) {
    step = stepMatch[1].trim();
    rest = rest.replace(stepMatch[0], '');
  }

  const causeMatch = rest.match(/\|\s*cause:\s*(.+?)(?=\s*\||$)/);
  if (causeMatch) {
    cause = causeMatch[1].trim();
    rest = rest.replace(causeMatch[0], '');
  }

  const message = rest.trim();

  return {
    timestamp,
    level,
    message,
    category,
    filePath,
    step,
    cause,
  };
}

/**
 * Checks if the given level meets the minimum level threshold.
 *
 * @param level - The log level to check
 * @param minLevel - The minimum level threshold
 * @returns true if level should be logged
 */
export function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_VALUES[level] <= LOG_LEVEL_VALUES[minLevel];
}

/**
 * Creates a LogEntry from a PipelineError.
 *
 * @param error - The PipelineError to convert
 * @param level - The log level (defaults to ERROR)
 * @param getCurrentDate - Optional function to get current date (for testing)
 * @returns A structured LogEntry
 */
export function createLogEntryFromError(
  error: PipelineError,
  level: LogLevel = 'ERROR',
  getCurrentDate?: () => Date,
): LogEntry {
  const now = getCurrentDate ? getCurrentDate() : new Date();
  return {
    timestamp: now.toISOString(),
    level,
    message: error.message,
    category: error.category,
    filePath: error.filePath,
    step: error.step,
    cause: error.cause?.message ?? null,
  };
}

/**
 * Creates a LogEntry from a generic message.
 *
 * @param level - The log level
 * @param message - The log message
 * @param options - Optional context fields
 * @param getCurrentDate - Optional function to get current date (for testing)
 * @returns A structured LogEntry
 */
export function createLogEntry(
  level: LogLevel,
  message: string,
  options?: {
    category?: ErrorCategory;
    filePath?: string;
    step?: string;
    cause?: string;
  },
  getCurrentDate?: () => Date,
): LogEntry {
  const now = getCurrentDate ? getCurrentDate() : new Date();
  return {
    timestamp: now.toISOString(),
    level,
    message,
    category: options?.category ?? null,
    filePath: options?.filePath ?? null,
    step: options?.step ?? null,
    cause: options?.cause ?? null,
  };
}

// ─── Logger Class ────────────────────────────────────────────────────────

/**
 * Logger for the Audio Pipeline application.
 *
 * Provides structured logging with support for:
 * - File output (daily-rotated log files)
 * - In-memory log storage for GUI display
 * - PipelineError integration
 * - Log level filtering
 * - Log summary and export
 * - Log file size rotation
 *
 * Usage:
 * ```typescript
 * const logger = new Logger({ logDir: '/path/to/logs' });
 * await logger.initialize();
 * logger.error('Something failed', { filePath: '/music/song.mp3', category: 'FileReadError' });
 * logger.logPipelineError(new FileReadError('file not found', { filePath: '/music/song.mp3' }));
 * ```
 */
export class Logger {
  private readonly logDir: string;
  private readonly minLevel: LogLevel;
  private readonly writeToFile: boolean;
  private readonly maxFileSize: number;
  private readonly getCurrentDate: () => Date;

  /** In-memory log entries for the current session */
  private entries: LogEntry[] = [];

  /** Whether the logger has been initialized (log directory created) */
  private initialized = false;

  constructor(options?: LoggerOptions) {
    this.logDir = options?.logDir ?? getDefaultLogDir();
    this.minLevel = options?.minLevel ?? 'INFO';
    this.writeToFile = options?.writeToFile ?? true;
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.getCurrentDate = options?.getCurrentDate ?? ((): Date => new Date());
  }

  /**
   * Initializes the logger by ensuring the log directory exists.
   * Must be called before logging to files. If writeToFile is false,
   * this is a no-op.
   */
  async initialize(): Promise<void> {
    if (!this.writeToFile) {
      this.initialized = true;
      return;
    }

    try {
      await fs.promises.mkdir(this.logDir, { recursive: true });
      this.initialized = true;
    } catch (error: unknown) {
      // If we can't create the log directory, disable file logging
      // but still allow in-memory logging
      this.initialized = true;
      const message = error instanceof Error ? error.message : String(error);
      this.entries.push(
        createLogEntry(
          'WARN',
          `Failed to create log directory "${this.logDir}": ${message}. File logging disabled.`,
          undefined,
          this.getCurrentDate,
        ),
      );
    }
  }

  /**
   * Returns the current log file path based on today's date.
   */
  getLogFilePath(): string {
    const fileName = getLogFileName(this.getCurrentDate());
    return path.join(this.logDir, fileName);
  }

  /**
   * Returns the log directory path.
   */
  getLogDir(): string {
    return this.logDir;
  }

  /**
   * Returns whether the logger has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ─── Logging Methods ────────────────────────────────────────────────

  /**
   * Logs an ERROR level message.
   *
   * @param message - The error message
   * @param options - Optional context (category, filePath, step, cause)
   */
  error(
    message: string,
    options?: {
      category?: ErrorCategory;
      filePath?: string;
      step?: string;
      cause?: string;
    },
  ): void {
    this.log('ERROR', message, options);
  }

  /**
   * Logs a WARN level message.
   *
   * @param message - The warning message
   * @param options - Optional context (category, filePath, step, cause)
   */
  warn(
    message: string,
    options?: {
      category?: ErrorCategory;
      filePath?: string;
      step?: string;
      cause?: string;
    },
  ): void {
    this.log('WARN', message, options);
  }

  /**
   * Logs an INFO level message.
   *
   * @param message - The informational message
   * @param options - Optional context (category, filePath, step, cause)
   */
  info(
    message: string,
    options?: {
      category?: ErrorCategory;
      filePath?: string;
      step?: string;
      cause?: string;
    },
  ): void {
    this.log('INFO', message, options);
  }

  /**
   * Logs a PipelineError with full context.
   * Automatically extracts category, filePath, step, and cause from the error.
   *
   * @param error - The PipelineError to log
   * @param level - Log level override (defaults to ERROR)
   */
  logPipelineError(error: PipelineError, level: LogLevel = 'ERROR'): void {
    const entry = createLogEntryFromError(error, level, this.getCurrentDate);
    this.addEntry(entry);
  }

  /**
   * Logs any error, wrapping non-PipelineError types automatically.
   * If the error is a PipelineError, its context is preserved.
   * Otherwise, a generic ERROR entry is created.
   *
   * @param error - The error to log
   * @param context - Optional additional context
   */
  logError(
    error: unknown,
    context?: {
      filePath?: string;
      step?: string;
    },
  ): void {
    if (isPipelineError(error)) {
      this.logPipelineError(error);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.message : undefined;
    this.error(message, {
      filePath: context?.filePath,
      step: context?.step,
      cause,
    });
  }

  /**
   * Logs a skipped file (WARN level).
   *
   * @param filePath - Path of the skipped file
   * @param reason - Reason the file was skipped
   */
  logSkippedFile(filePath: string, reason: string): void {
    this.warn(`File skipped: ${reason}`, {
      filePath,
      step: 'processing',
    });
  }

  // ─── Core Logging ──────────────────────────────────────────────────

  /**
   * Core logging method. Creates a LogEntry, stores it in memory,
   * and writes to file if enabled.
   *
   * @param level - Log level
   * @param message - Log message
   * @param options - Optional context
   */
  private log(
    level: LogLevel,
    message: string,
    options?: {
      category?: ErrorCategory;
      filePath?: string;
      step?: string;
      cause?: string;
    },
  ): void {
    if (!shouldLog(level, this.minLevel)) return;

    const entry = createLogEntry(level, message, options, this.getCurrentDate);
    this.addEntry(entry);
  }

  /**
   * Adds a log entry to in-memory storage and writes to file.
   *
   * @param entry - The log entry to add
   */
  private addEntry(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.writeToFile && this.initialized) {
      this.writeEntryToFile(entry);
    }
  }

  /**
   * Writes a log entry to the current log file.
   * Handles file rotation if the file exceeds maxFileSize.
   * Errors during file write are silently caught (logging should never crash the app).
   *
   * @param entry - The log entry to write
   */
  private writeEntryToFile(entry: LogEntry): void {
    try {
      const logFilePath = this.getLogFilePath();
      const formatted = formatLogEntry(entry) + '\n';

      // Check if file exists and needs rotation
      if (fs.existsSync(logFilePath)) {
        const stats = fs.statSync(logFilePath);
        if (stats.size >= this.maxFileSize) {
          this.rotateLogFile(logFilePath);
        }
      }

      // Ensure log directory exists (handle race conditions)
      const dir = path.dirname(logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.appendFileSync(logFilePath, formatted, 'utf-8');
    } catch {
      // Silently ignore file write errors - logging should never crash the app
    }
  }

  /**
   * Rotates a log file by renaming it with a numeric suffix.
   * e.g., 2024-01-15.log → 2024-01-15.1.log
   *
   * @param logFilePath - The current log file path
   */
  private rotateLogFile(logFilePath: string): void {
    try {
      const ext = path.extname(logFilePath);
      const base = logFilePath.slice(0, -ext.length);

      let rotationIndex = 1;
      let rotatedPath = `${base}.${rotationIndex}${ext}`;
      while (fs.existsSync(rotatedPath)) {
        rotationIndex++;
        rotatedPath = `${base}.${rotationIndex}${ext}`;
      }

      fs.renameSync(logFilePath, rotatedPath);
    } catch {
      // Silently ignore rotation errors
    }
  }

  // ─── Retrieval Methods ─────────────────────────────────────────────

  /**
   * Returns all in-memory log entries, optionally filtered.
   *
   * @param filter - Optional filter criteria
   * @returns Filtered array of log entries
   */
  getEntries(filter?: LogFilter): LogEntry[] {
    let entries = [...this.entries];

    if (filter?.level) {
      entries = entries.filter((e) => e.level === filter.level);
    }

    if (filter?.category) {
      entries = entries.filter((e) => e.category === filter.category);
    }

    if (filter?.filePath) {
      const search = filter.filePath.toLowerCase();
      entries = entries.filter((e) => e.filePath && e.filePath.toLowerCase().includes(search));
    }

    if (filter?.limit && filter.limit > 0) {
      entries = entries.slice(-filter.limit);
    }

    return entries;
  }

  /**
   * Returns only ERROR entries from the in-memory log.
   *
   * @param limit - Maximum number of entries to return
   * @returns Array of ERROR log entries
   */
  getErrors(limit?: number): LogEntry[] {
    return this.getEntries({ level: 'ERROR', limit });
  }

  /**
   * Returns only WARN entries from the in-memory log.
   *
   * @param limit - Maximum number of entries to return
   * @returns Array of WARN log entries
   */
  getWarnings(limit?: number): LogEntry[] {
    return this.getEntries({ level: 'WARN', limit });
  }

  /**
   * Returns a summary of the current log state.
   *
   * @returns LogSummary with counts and breakdown
   */
  getSummary(): LogSummary {
    const errorsByCategory: Record<string, number> = {};

    let errorCount = 0;
    let warnCount = 0;
    let infoCount = 0;

    for (const entry of this.entries) {
      switch (entry.level) {
        case 'ERROR':
          errorCount++;
          if (entry.category) {
            errorsByCategory[entry.category] = (errorsByCategory[entry.category] || 0) + 1;
          }
          break;
        case 'WARN':
          warnCount++;
          break;
        case 'INFO':
          infoCount++;
          break;
      }
    }

    return {
      totalEntries: this.entries.length,
      errorCount,
      warnCount,
      infoCount,
      errorsByCategory,
      logFilePath: this.writeToFile ? this.getLogFilePath() : null,
    };
  }

  /**
   * Returns the number of in-memory log entries.
   */
  get size(): number {
    return this.entries.length;
  }

  // ─── Export Methods ────────────────────────────────────────────────

  /**
   * Exports all in-memory log entries to a file at the specified path.
   * Creates parent directories if they don't exist.
   *
   * @param exportPath - Absolute path to write the exported log
   * @returns true if export was successful, false otherwise
   */
  async exportLog(exportPath: string): Promise<boolean> {
    try {
      const dir = path.dirname(exportPath);
      await fs.promises.mkdir(dir, { recursive: true });

      const lines = this.entries.map(formatLogEntry);
      const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');

      await fs.promises.writeFile(exportPath, content, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads and parses a log file, returning structured entries.
   *
   * @param logFilePath - Path to the log file (defaults to today's log)
   * @returns Array of parsed LogEntry objects
   */
  async readLogFile(logFilePath?: string): Promise<LogEntry[]> {
    const filePath = logFilePath ?? this.getLogFilePath();

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const entries: LogEntry[] = [];

      for (const line of lines) {
        const parsed = parseLogLine(line);
        if (parsed) {
          entries.push(parsed);
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Lists all log files in the log directory, sorted by date (newest first).
   *
   * @returns Array of absolute file paths to log files
   */
  async listLogFiles(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.logDir);
      const logFiles = files
        .filter((f) => f.endsWith('.log'))
        .sort()
        .reverse()
        .map((f) => path.join(this.logDir, f));
      return logFiles;
    } catch {
      return [];
    }
  }

  // ─── Lifecycle Methods ─────────────────────────────────────────────

  /**
   * Clears all in-memory log entries.
   * Does NOT delete log files.
   */
  clear(): void {
    this.entries = [];
  }
}
