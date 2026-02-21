/**
 * Audio Reader Service
 *
 * Reads audio files and extracts metadata using the music-metadata library.
 * Supports MP3, FLAC, M4A, WAV, OGG, and WMA formats.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as mm from 'music-metadata';
import { AudioFileMetadata, AudioFormat, SUPPORTED_EXTENSIONS } from '../../shared/types';

/**
 * Maps a file extension to the AudioFormat type.
 * @param filePath - Path to the audio file
 * @returns The AudioFormat string or null if unsupported
 */
export function getAudioFormat(filePath: string): AudioFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return null;
  }
  // Remove the leading dot to get the format
  return ext.slice(1) as AudioFormat;
}

/**
 * Reads an audio file and extracts its metadata into an AudioFileMetadata object.
 *
 * Uses the music-metadata library to parse audio files. Handles corrupted or
 * missing metadata gracefully by returning null for unavailable fields.
 *
 * @param filePath - Absolute path to the audio file
 * @returns A promise that resolves to the extracted AudioFileMetadata
 * @throws Error if the file does not exist or cannot be read
 * @throws Error if the file format is not supported
 */
export async function readAudioFile(filePath: string): Promise<AudioFileMetadata> {
  // Validate file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Validate format is supported
  const format = getAudioFormat(filePath);
  if (format === null) {
    throw new Error(`Unsupported audio format: ${path.extname(filePath)}`);
  }

  // Get file size
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  // Parse audio metadata using music-metadata
  let metadata: mm.IAudioMetadata;
  try {
    metadata = await mm.parseFile(filePath, {
      duration: true,
      skipCovers: true,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse audio file "${path.basename(filePath)}": ${message}`);
  }

  // Extract and map metadata to our AudioFileMetadata interface
  return mapToAudioFileMetadata(filePath, format, fileSize, metadata);
}

/**
 * Reads multiple audio files and returns their metadata.
 * Files that fail to parse are included with partial data and logged.
 *
 * @param filePaths - Array of absolute paths to audio files
 * @returns A promise that resolves to an array of results, each containing
 *          either the metadata or an error
 */
export async function readMultipleAudioFiles(
  filePaths: string[],
): Promise<Array<{ filePath: string; metadata: AudioFileMetadata | null; error: string | null }>> {
  const results: Array<{
    filePath: string;
    metadata: AudioFileMetadata | null;
    error: string | null;
  }> = [];

  for (const filePath of filePaths) {
    try {
      const metadata = await readAudioFile(filePath);
      results.push({ filePath, metadata, error: null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ filePath, metadata: null, error: message });
    }
  }

  return results;
}

/**
 * Maps music-metadata parsed results to our AudioFileMetadata interface.
 * Handles missing/undefined fields gracefully by returning null.
 *
 * @param filePath - Original file path
 * @param format - Detected audio format
 * @param fileSize - File size in bytes
 * @param metadata - Parsed metadata from music-metadata
 * @returns AudioFileMetadata object with all fields populated or null
 */
function mapToAudioFileMetadata(
  filePath: string,
  format: AudioFormat,
  fileSize: number,
  metadata: mm.IAudioMetadata,
): AudioFileMetadata {
  const common = metadata.common;
  const formatInfo = metadata.format;

  return {
    filePath,
    format,
    fileSize,
    duration: formatInfo.duration ?? 0,
    title: common.title ?? null,
    artist: common.artist ?? null,
    album: common.album ?? null,
    year: common.year ?? null,
    genre: common.genre && common.genre.length > 0 ? common.genre : null,
    trackNumber: common.track?.no ?? null,
    discNumber: common.disk?.no ?? null,
    albumArtist: common.albumartist ?? null,
    lyrics: extractLyrics(common, metadata.native) ?? null,
  };
}

/**
 * Extracts lyrics from metadata.
 * Checks the common.lyrics field first, then falls back to native USLT tags.
 *
 * @param common - Common metadata from music-metadata
 * @param native - Native tag data from music-metadata
 * @returns Extracted lyrics text or null if not found
 */
function extractLyrics(
  common: mm.ICommonTagsResult,
  native: mm.IAudioMetadata['native'],
): string | null {
  // Check common lyrics field first
  if (common.lyrics && common.lyrics.length > 0) {
    // common.lyrics is an array of strings
    return common.lyrics.join('\n');
  }

  // Fall back to native USLT tags (ID3v2)
  for (const tagType of Object.keys(native)) {
    const tags = native[tagType];
    if (!tags) continue;

    for (const tag of tags) {
      if (tag.id === 'USLT' && tag.value) {
        // USLT tag value can be an object with text property or a string
        if (typeof tag.value === 'string') {
          return tag.value;
        }
        if (typeof tag.value === 'object' && 'text' in tag.value) {
          return (tag.value as { text: string }).text;
        }
      }
    }
  }

  return null;
}
