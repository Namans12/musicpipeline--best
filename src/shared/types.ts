/**
 * Shared type definitions for the Audio Pipeline application.
 * These interfaces are used across main and renderer processes.
 */

/** Supported audio file formats */
export type AudioFormat = 'mp3' | 'flac' | 'm4a' | 'wav' | 'ogg' | 'wma';

/** Supported audio file extensions (with dot prefix) */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.mp3',
  '.flac',
  '.m4a',
  '.wav',
  '.ogg',
  '.wma',
] as const;

/** Metadata extracted from an audio file */
export interface AudioFileMetadata {
  /** Absolute path to the audio file */
  filePath: string;
  /** Audio format (mp3, flac, etc.) */
  format: AudioFormat;
  /** File size in bytes */
  fileSize: number;
  /** Duration in seconds */
  duration: number;
  /** Song title */
  title: string | null;
  /** Primary artist name */
  artist: string | null;
  /** Album name */
  album: string | null;
  /** Release year */
  year: number | null;
  /** Genre(s) */
  genre: string[] | null;
  /** Track number on album */
  trackNumber: number | null;
  /** Disc number */
  discNumber: number | null;
  /** Album artist (may differ from track artist) */
  albumArtist: string | null;
  /** Unsynchronized lyrics (USLT) */
  lyrics: string | null;
}

/** Result of an AcoustID fingerprint lookup */
export interface FingerprintResult {
  /** AcoustID match score (0-1, higher is better) */
  score: number;
  /** AcoustID ID */
  acoustId: string;
  /** MusicBrainz Recording IDs matched */
  recordingIds: string[];
}

/** Metadata fetched from MusicBrainz */
export interface MusicBrainzMetadata {
  /** MusicBrainz Recording ID */
  recordingId: string;
  /** MusicBrainz Release ID (used to fetch cover art from Cover Art Archive) */
  releaseId: string | null;
  /** Song title */
  title: string;
  /** Primary artist name */
  artist: string;
  /** Featured/additional artists */
  featuredArtists: string[];
  /** Album/release name */
  album: string | null;
  /** Release year */
  year: number | null;
  /** Genre tags */
  genres: string[];
}

/** Processing status for a single file */
export type ProcessingStatus =
  | 'pending'
  | 'fingerprinting'
  | 'identifying'
  | 'fetching_metadata'
  | 'fetching_lyrics'
  | 'writing_tags'
  | 'renaming'
  | 'completed'
  | 'error'
  | 'skipped';

/** Result of processing a single file */
export interface ProcessingResult {
  /** Original file path */
  originalPath: string;
  /** New file path (after rename, if applicable) */
  newPath: string | null;
  /** Processing status */
  status: ProcessingStatus;
  /** Error message if status is 'error' */
  error: string | null;
  /** Pipeline step where the error occurred (e.g. 'fingerprinting', 'fetching_metadata') */
  failedStep?: string;
  /** Original metadata read from file */
  originalMetadata: AudioFileMetadata | null;
  /** Corrected metadata from APIs */
  correctedMetadata: AudioFileMetadata | null;
}

/** Progress update sent from main process to renderer */
export interface ProgressUpdate {
  /** Total number of files to process */
  totalFiles: number;
  /** Number of files processed so far */
  processedFiles: number;
  /** Number of successful files */
  successCount: number;
  /** Number of errored files */
  errorCount: number;
  /** Number of skipped files */
  skippedCount: number;
  /** Currently processing file name */
  currentFile: string | null;
  /** Estimated time remaining in seconds */
  estimatedTimeRemaining: number | null;
}

/** Application settings */
export interface AppSettings {
  /** Output folder (null = same as input) */
  outputFolder: string | null;
  /** File naming template */
  namingTemplate: string;
  /** Number of concurrent file processes */
  concurrency: number;
  /** Whether to fetch lyrics */
  fetchLyrics: boolean;
  /** Whether to overwrite existing tags */
  overwriteExistingTags: boolean;
  /** Whether to use persistent cache (SQLite) for API results across sessions */
  usePersistentCache: boolean;
  /** AcoustID API key for audio fingerprint identification */
  acoustIdApiKey: string;
  /** Whether to use Spotify Web API as a metadata/artwork source */
  useSpotify: boolean;
  /** Spotify application Client ID (required when useSpotify is true) */
  spotifyClientId: string;
  /** Spotify application Client Secret (required when useSpotify is true) */
  spotifyClientSecret: string;
  /** Whether to use Genius API as an additional lyrics source */
  useGenius: boolean;
  /** Genius Client Access Token (from genius.com/api-clients) */
  geniusAccessToken: string;
}

/** Default application settings */
export const DEFAULT_SETTINGS: AppSettings = {
  outputFolder: null,
  namingTemplate: '{artist} - {title}',
  concurrency: 5,
  fetchLyrics: true,
  overwriteExistingTags: false,
  usePersistentCache: true,
  acoustIdApiKey: '',
  useSpotify: false,
  spotifyClientId: '',
  spotifyClientSecret: '',
  useGenius: false,
  geniusAccessToken: '',
};

/**
 * IPC channel names for Electron communication
 */
export const IPC_CHANNELS = {
  SELECT_FILES: 'select-files',
  SELECT_FOLDER: 'select-folder',
  START_PROCESSING: 'start-processing',
  CANCEL_PROCESSING: 'cancel-processing',
  PROGRESS_UPDATE: 'progress-update',
  PROCESSING_COMPLETE: 'processing-complete',
  FILE_COMPLETE: 'file-complete',
  GET_SETTINGS: 'get-settings',
  SAVE_SETTINGS: 'save-settings',
  GET_FILE_METADATA: 'get-file-metadata',
  GET_ERRORS: 'get-errors',
  EXPORT_ERROR_LOG: 'export-error-log',
  SELECT_OUTPUT_FOLDER: 'select-output-folder',
  CLEAR_CACHE: 'clear-cache',
  GET_CACHE_STATS: 'get-cache-stats',
} as const;
