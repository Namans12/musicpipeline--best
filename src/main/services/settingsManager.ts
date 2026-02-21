/**
 * Settings Manager Service for Audio Pipeline
 *
 * Provides settings persistence using JSON file storage. Settings are stored
 * at %APPDATA%/audio-pipeline/settings.json (Windows) or
 * ~/.config/audio-pipeline/settings.json (other platforms).
 *
 * Features:
 * - JSON-based file persistence
 * - Schema validation with safe defaults
 * - Settings change notification via listener pattern
 * - Thread-safe read/write operations
 * - Graceful error handling (falls back to defaults on corrupt files)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppSettings, DEFAULT_SETTINGS } from '../../shared/types';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Options for configuring the SettingsManager */
export interface SettingsManagerOptions {
  /** Custom directory to store settings file. Defaults to platform-specific appdata */
  settingsDir?: string;
  /** Custom filename for the settings file. Defaults to 'settings.json' */
  fileName?: string;
}

/** Listener callback type for settings changes */
export type SettingsChangeListener = (settings: AppSettings) => void;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default app data directory name */
const APP_DIR_NAME = 'audio-pipeline';

/** Default settings filename */
const DEFAULT_SETTINGS_FILENAME = 'settings.json';

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Returns the default settings directory path based on the platform.
 * On Windows: %APPDATA%/audio-pipeline/
 * On other platforms: ~/.config/audio-pipeline/
 */
export function getDefaultSettingsDir(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(appData, APP_DIR_NAME);
}

/**
 * Validates a concurrency value and clamps it to the valid range (1-10).
 *
 * @param value - The value to validate
 * @returns The clamped concurrency value
 */
export function validateConcurrency(value: unknown): number {
  if (typeof value !== 'number' || isNaN(value)) {
    return DEFAULT_SETTINGS.concurrency;
  }
  return Math.max(1, Math.min(10, Math.round(value)));
}

/**
 * Validates a naming template string.
 * Must contain at least {artist} or {title} placeholder.
 *
 * @param template - The template string to validate
 * @returns true if the template is valid
 */
export function validateNamingTemplate(template: unknown): boolean {
  if (typeof template !== 'string' || template.trim().length === 0) {
    return false;
  }
  return template.includes('{artist}') || template.includes('{title}');
}

/**
 * Validates and sanitizes a partial settings object, merging with defaults.
 * Returns a complete, valid AppSettings object.
 *
 * @param partial - A partial or potentially invalid settings object
 * @returns A validated AppSettings object
 */
export function validateSettings(partial: unknown): AppSettings {
  if (partial === null || partial === undefined || typeof partial !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }

  const raw = partial as Record<string, unknown>;
  const validated: AppSettings = { ...DEFAULT_SETTINGS };

  // outputFolder: string | null
  if (raw.outputFolder === null || typeof raw.outputFolder === 'string') {
    validated.outputFolder =
      typeof raw.outputFolder === 'string' && raw.outputFolder.trim().length > 0
        ? raw.outputFolder.trim()
        : null;
  }

  // namingTemplate: string (must contain {artist} or {title})
  if (validateNamingTemplate(raw.namingTemplate)) {
    validated.namingTemplate = (raw.namingTemplate as string).trim();
  }

  // concurrency: number (1-10)
  if (raw.concurrency !== undefined) {
    validated.concurrency = validateConcurrency(raw.concurrency);
  }

  // fetchLyrics: boolean
  if (typeof raw.fetchLyrics === 'boolean') {
    validated.fetchLyrics = raw.fetchLyrics;
  }

  // overwriteExistingTags: boolean
  if (typeof raw.overwriteExistingTags === 'boolean') {
    validated.overwriteExistingTags = raw.overwriteExistingTags;
  }

  // usePersistentCache: boolean
  if (typeof raw.usePersistentCache === 'boolean') {
    validated.usePersistentCache = raw.usePersistentCache;
  }

  // acoustIdApiKey: string (trimmed, defaults to '')
  if (typeof raw.acoustIdApiKey === 'string') {
    validated.acoustIdApiKey = raw.acoustIdApiKey.trim();
  }

  // useSpotify: boolean
  if (typeof raw.useSpotify === 'boolean') {
    validated.useSpotify = raw.useSpotify;
  }

  // spotifyClientId: string (trimmed, defaults to '')
  if (typeof raw.spotifyClientId === 'string') {
    validated.spotifyClientId = raw.spotifyClientId.trim();
  }

  // spotifyClientSecret: string (trimmed, defaults to '')
  if (typeof raw.spotifyClientSecret === 'string') {
    validated.spotifyClientSecret = raw.spotifyClientSecret.trim();
  }

  // useGenius: boolean
  if (typeof raw.useGenius === 'boolean') {
    validated.useGenius = raw.useGenius;
  }

  // geniusAccessToken: string (trimmed, defaults to '')
  if (typeof raw.geniusAccessToken === 'string') {
    validated.geniusAccessToken = raw.geniusAccessToken.trim();
  }

  return validated;
}

/**
 * Serializes settings to a JSON string for file storage.
 *
 * @param settings - The settings to serialize
 * @returns The JSON string
 */
export function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(settings, null, 2);
}

/**
 * Deserializes a JSON string to a settings object.
 * Returns null if the JSON is invalid.
 *
 * @param json - The JSON string to parse
 * @returns The parsed settings or null
 */
export function deserializeSettings(json: string): Partial<AppSettings> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Partial<AppSettings>;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── SettingsManager Class ───────────────────────────────────────────────────

/**
 * Manages application settings with file-based persistence.
 *
 * Usage:
 * ```typescript
 * const manager = new SettingsManager();
 * await manager.initialize(); // Load settings from file (or use defaults)
 *
 * const settings = manager.get(); // Read current settings
 * await manager.save({ concurrency: 3 }); // Partial update + persist
 * await manager.reset(); // Reset to defaults + persist
 * ```
 */
export class SettingsManager {
  private settings: AppSettings;
  private readonly settingsDir: string;
  private readonly fileName: string;
  private readonly listeners: SettingsChangeListener[] = [];
  private initialized = false;

  constructor(options?: SettingsManagerOptions) {
    this.settingsDir = options?.settingsDir ?? getDefaultSettingsDir();
    this.fileName = options?.fileName ?? DEFAULT_SETTINGS_FILENAME;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  /**
   * Initializes the settings manager by loading settings from file.
   * If the file doesn't exist or is corrupt, uses defaults.
   * Creates the settings directory if it doesn't exist.
   */
  async initialize(): Promise<void> {
    // Create settings directory if needed
    try {
      await fs.promises.mkdir(this.settingsDir, { recursive: true });
    } catch {
      // Directory creation failed - will use in-memory only
    }

    // Load settings from file
    const filePath = this.getFilePath();
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = deserializeSettings(content);
      if (parsed) {
        this.settings = validateSettings(parsed);
      }
    } catch {
      // File doesn't exist or can't be read - use defaults
    }

    this.initialized = true;
  }

  /**
   * Returns whether the settings manager has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Gets the current settings (copy to prevent mutation).
   *
   * @returns A copy of the current AppSettings
   */
  get(): AppSettings {
    return { ...this.settings };
  }

  /**
   * Updates settings with a partial update and persists to file.
   * Validates all values and merges with current settings.
   *
   * @param updates - Partial settings to merge
   * @returns The updated settings
   */
  async save(updates: Partial<AppSettings>): Promise<AppSettings> {
    // Merge updates with current settings, then validate
    const merged = { ...this.settings, ...updates };
    this.settings = validateSettings(merged);

    // Persist to file
    await this.writeToFile();

    // Notify listeners
    this.notifyListeners();

    return { ...this.settings };
  }

  /**
   * Resets all settings to defaults and persists.
   *
   * @returns The default settings
   */
  async reset(): Promise<AppSettings> {
    this.settings = { ...DEFAULT_SETTINGS };

    // Persist to file
    await this.writeToFile();

    // Notify listeners
    this.notifyListeners();

    return { ...this.settings };
  }

  /**
   * Returns the full path to the settings file.
   */
  getFilePath(): string {
    return path.join(this.settingsDir, this.fileName);
  }

  /**
   * Returns the settings directory path.
   */
  getSettingsDir(): string {
    return this.settingsDir;
  }

  /**
   * Registers a listener for settings changes.
   * Returns an unsubscribe function.
   *
   * @param listener - Callback invoked with new settings on change
   * @returns Unsubscribe function
   */
  onChange(listener: SettingsChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Returns the number of registered listeners.
   */
  getListenerCount(): number {
    return this.listeners.length;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Writes the current settings to the settings file.
   * Creates the directory if it doesn't exist.
   */
  private async writeToFile(): Promise<void> {
    const filePath = this.getFilePath();
    try {
      await fs.promises.mkdir(this.settingsDir, { recursive: true });
      await fs.promises.writeFile(filePath, serializeSettings(this.settings), 'utf-8');
    } catch {
      // Write failure is non-fatal - settings remain in memory
    }
  }

  /**
   * Notifies all registered listeners of settings changes.
   */
  private notifyListeners(): void {
    const settingsCopy = { ...this.settings };
    for (const listener of this.listeners) {
      try {
        listener(settingsCopy);
      } catch {
        // Listener error is non-fatal
      }
    }
  }
}
