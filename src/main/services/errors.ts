/**
 * Custom Error Classes for Audio Pipeline
 *
 * Provides categorized error types for each processing step,
 * enabling structured error handling, logging, and user-friendly error messages.
 */

/**
 * Error categories matching the processing pipeline steps.
 */
export type ErrorCategory = 'FileReadError' | 'FingerprintError' | 'APIError' | 'WriteError';

/**
 * Base class for all Audio Pipeline errors.
 * Extends the native Error class with additional context fields.
 */
export class PipelineError extends Error {
  /** Error category for classification */
  readonly category: ErrorCategory;
  /** The file being processed when the error occurred (if applicable) */
  readonly filePath: string | null;
  /** The processing step where the error occurred */
  readonly step: string;
  /** The original error that caused this error (if wrapping) */
  readonly cause: Error | null;
  /** Timestamp when the error was created */
  readonly timestamp: Date;

  constructor(
    message: string,
    category: ErrorCategory,
    options?: {
      filePath?: string;
      step?: string;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = category;
    this.category = category;
    this.filePath = options?.filePath ?? null;
    this.step = options?.step ?? category;
    this.cause = options?.cause ?? null;
    this.timestamp = new Date();

    // Ensure prototype chain works correctly
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns a structured object representation of the error for logging.
   */
  toLogObject(): {
    category: ErrorCategory;
    message: string;
    filePath: string | null;
    step: string;
    timestamp: string;
    stack: string | undefined;
    cause: string | null;
  } {
    return {
      category: this.category,
      message: this.message,
      filePath: this.filePath,
      step: this.step,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
      cause: this.cause?.message ?? null,
    };
  }

  /**
   * Returns a user-friendly error message (no stack traces).
   */
  toUserMessage(): string {
    const fileInfo = this.filePath ? ` [${this.filePath}]` : '';
    return `${this.category}${fileInfo}: ${this.message}`;
  }
}

/**
 * Error thrown when reading or parsing an audio file fails.
 * Examples: file not found, unsupported format, corrupt file, permission denied.
 */
export class FileReadError extends PipelineError {
  constructor(
    message: string,
    options?: {
      filePath?: string;
      step?: string;
      cause?: Error;
    },
  ) {
    super(message, 'FileReadError', {
      step: 'reading',
      ...options,
    });
  }
}

/**
 * Error thrown when audio fingerprinting fails.
 * Examples: fpcalc not found, fpcalc timeout, invalid fingerprint output.
 */
export class FingerprintError extends PipelineError {
  constructor(
    message: string,
    options?: {
      filePath?: string;
      step?: string;
      cause?: Error;
    },
  ) {
    super(message, 'FingerprintError', {
      step: 'fingerprinting',
      ...options,
    });
  }
}

/**
 * Error thrown when an external API call fails.
 * Examples: AcoustID lookup failure, MusicBrainz timeout, rate limit exceeded,
 * lyrics API unavailable.
 */
export class APIError extends PipelineError {
  /** HTTP status code (if applicable) */
  readonly statusCode: number | null;
  /** Name of the API service that failed */
  readonly service: string | null;

  constructor(
    message: string,
    options?: {
      filePath?: string;
      step?: string;
      cause?: Error;
      statusCode?: number;
      service?: string;
    },
  ) {
    super(message, 'APIError', {
      step: 'api_call',
      ...options,
    });
    this.statusCode = options?.statusCode ?? null;
    this.service = options?.service ?? null;
  }

  override toLogObject(): ReturnType<PipelineError['toLogObject']> & {
    statusCode: number | null;
    service: string | null;
  } {
    return {
      ...super.toLogObject(),
      statusCode: this.statusCode,
      service: this.service,
    };
  }
}

/**
 * Error thrown when writing tags or renaming files fails.
 * Examples: permission denied, disk full, tag write failure.
 */
export class WriteError extends PipelineError {
  constructor(
    message: string,
    options?: {
      filePath?: string;
      step?: string;
      cause?: Error;
    },
  ) {
    super(message, 'WriteError', {
      step: 'writing',
      ...options,
    });
  }
}

/**
 * Type guard to check if an error is a PipelineError.
 */
export function isPipelineError(error: unknown): error is PipelineError {
  return error instanceof PipelineError;
}

/**
 * Wraps a generic error in the appropriate PipelineError category.
 * If the error is already a PipelineError, it is returned as-is.
 *
 * @param error - The error to wrap
 * @param category - The error category to use
 * @param options - Additional context
 * @returns A PipelineError instance
 */
export function wrapError(
  error: unknown,
  category: ErrorCategory,
  options?: {
    filePath?: string;
    step?: string;
  },
): PipelineError {
  if (error instanceof PipelineError) {
    return error;
  }

  const cause = error instanceof Error ? error : new Error(String(error));
  const message = cause.message || 'Unknown error';

  switch (category) {
    case 'FileReadError':
      return new FileReadError(message, { ...options, cause });
    case 'FingerprintError':
      return new FingerprintError(message, { ...options, cause });
    case 'APIError':
      return new APIError(message, { ...options, cause });
    case 'WriteError':
      return new WriteError(message, { ...options, cause });
  }
}
