/**
 * File Scanner Utility
 *
 * Recursively scans directories for supported audio files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SUPPORTED_EXTENSIONS } from '../../shared/types';

/**
 * Checks if a file has a supported audio extension.
 * @param filePath - Path to the file
 * @returns true if the file extension is supported
 */
export function isSupportedAudioFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * Recursively scans a directory for audio files with supported extensions.
 * @param dirPath - Path to the directory to scan
 * @returns Array of absolute paths to audio files found
 */
export function scanDirectoryForAudioFiles(dirPath: string): string[] {
  const audioFiles: string[] = [];

  function scanRecursive(currentPath: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      // Skip directories we can't read (permissions, etc.)
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        scanRecursive(fullPath);
      } else if (entry.isFile() && isSupportedAudioFile(entry.name)) {
        audioFiles.push(fullPath);
      }
    }
  }

  scanRecursive(dirPath);
  return audioFiles.sort();
}

/**
 * Sanitizes a filename by removing characters invalid on Windows.
 * @param filename - The filename to sanitize
 * @returns Sanitized filename safe for Windows
 */
export function sanitizeFilename(filename: string): string {
  // Remove characters invalid on Windows: / \ : * ? " < > |
  return filename
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates a unique file path, appending (1), (2), etc. if the file already exists.
 * @param desiredPath - The desired file path
 * @returns A unique file path that doesn't conflict with existing files
 */
export function getUniqueFilePath(desiredPath: string): string {
  if (!fs.existsSync(desiredPath)) {
    return desiredPath;
  }

  const dir = path.dirname(desiredPath);
  const ext = path.extname(desiredPath);
  const baseName = path.basename(desiredPath, ext);

  let counter = 1;
  let candidatePath: string;

  do {
    candidatePath = path.join(dir, `${baseName} (${counter})${ext}`);
    counter++;
  } while (fs.existsSync(candidatePath));

  return candidatePath;
}
