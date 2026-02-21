/**
 * Audio Pipeline - Renderer Process
 *
 * Handles the GUI interactions and communicates with the main process via IPC.
 * This file is loaded by the renderer process in Electron.
 *
 * Wires up the DOM elements to the AppController for state management,
 * integrates the ProgressTracker for error display and export,
 * and uses window.electronAPI (exposed via preload script) for IPC communication.
 */

import type { ElectronAPI } from '../main/preload';
import type { AppSettings, ProcessingResult, ProgressUpdate } from '../shared/types';
import { AppController, getStatusIcon, getStatusLabel } from './appController';
import type { FileEntry } from './fileListManager';
import {
  ProgressTracker,
  type ErrorEntry,
  type ErrorModalState,
  type ErrorSummary,
} from './progressTracker';

// Declare the electronAPI on the window object
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

/**
 * Initializes the renderer application.
 * Sets up event listeners, wires DOM elements to the AppController,
 * integrates ProgressTracker for error viewing/export,
 * and registers IPC callbacks from the main process.
 */
function initializeApp(): void {
  const controller = new AppController();
  const tracker = new ProgressTracker();

  // ─── DOM Element References ──────────────────────────────────────────

  const btnSelectFiles = document.getElementById('btn-select-files') as HTMLButtonElement;
  const btnSelectFolder = document.getElementById('btn-select-folder') as HTMLButtonElement;
  const btnClearCache = document.getElementById('btn-clear-cache') as HTMLButtonElement;
  const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
  const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
  const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement;
  const fileListEl = document.getElementById('file-list') as HTMLDivElement;
  const fileListEmpty = document.getElementById('file-list-empty') as HTMLDivElement;
  const fileCountEl = document.getElementById('file-count') as HTMLSpanElement;
  const statusText = document.getElementById('status-text') as HTMLSpanElement;
  const progressArea = document.getElementById('progress-area') as HTMLDivElement;
  const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
  const progressLabel = document.getElementById('progress-label') as HTMLSpanElement;
  const progressPercentage = document.getElementById('progress-percentage') as HTMLSpanElement;
  const statSuccess = document.getElementById('stat-success') as HTMLSpanElement;
  const statError = document.getElementById('stat-error') as HTMLSpanElement;
  const statSkipped = document.getElementById('stat-skipped') as HTMLSpanElement;

  // Error action buttons
  const btnViewErrors = document.getElementById('btn-view-errors') as HTMLButtonElement;
  const btnExportLog = document.getElementById('btn-export-log') as HTMLButtonElement;

  // Error modal elements
  const errorModalOverlay = document.getElementById('error-modal-overlay') as HTMLDivElement;
  const btnModalClose = document.getElementById('btn-modal-close') as HTMLButtonElement;
  const btnModalCloseFooter = document.getElementById(
    'btn-modal-close-footer',
  ) as HTMLButtonElement;
  const btnModalExport = document.getElementById('btn-modal-export') as HTMLButtonElement;
  const errorModalSummary = document.getElementById('error-modal-summary') as HTMLDivElement;
  const errorList = document.getElementById('error-list') as HTMLUListElement;
  const errorListEmpty = document.getElementById('error-list-empty') as HTMLDivElement;
  const filterAll = document.getElementById('filter-all') as HTMLButtonElement;
  const filterErrors = document.getElementById('filter-errors') as HTMLButtonElement;
  const filterSkipped = document.getElementById('filter-skipped') as HTMLButtonElement;
  const apiKeyModalOverlay = document.getElementById('api-key-modal-overlay') as HTMLDivElement;
  const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
  const apiKeyError = document.getElementById('api-key-error') as HTMLDivElement;
  const btnApiKeyCancel = document.getElementById('btn-api-key-cancel') as HTMLButtonElement;
  const btnApiKeySave = document.getElementById('btn-api-key-save') as HTMLButtonElement;

  // Spotify credentials elements
  const spotifyEnabledCheckbox = document.getElementById(
    'spotify-enabled-checkbox',
  ) as HTMLInputElement;
  const btnSpotifyConfig = document.getElementById('btn-spotify-config') as HTMLButtonElement;
  const spotifyModalOverlay = document.getElementById('spotify-modal-overlay') as HTMLDivElement;
  const spotifyClientIdInput = document.getElementById(
    'spotify-client-id-input',
  ) as HTMLInputElement;
  const spotifyClientSecretInput = document.getElementById(
    'spotify-client-secret-input',
  ) as HTMLInputElement;
  const spotifyCredentialError = document.getElementById(
    'spotify-credential-error',
  ) as HTMLDivElement;
  const btnSpotifyCancel = document.getElementById('btn-spotify-cancel') as HTMLButtonElement;
  const btnSpotifySave = document.getElementById('btn-spotify-save') as HTMLButtonElement;

  // Genius credentials elements
  const geniusEnabledCheckbox = document.getElementById(
    'genius-enabled-checkbox',
  ) as HTMLInputElement;
  const btnGeniusConfig = document.getElementById('btn-genius-config') as HTMLButtonElement;
  const geniusModalOverlay = document.getElementById('genius-modal-overlay') as HTMLDivElement;
  const geniusTokenInput = document.getElementById('genius-token-input') as HTMLInputElement;
  const geniusTokenError = document.getElementById('genius-token-error') as HTMLDivElement;
  const btnGeniusCancel = document.getElementById('btn-genius-cancel') as HTMLButtonElement;
  const btnGeniusSave = document.getElementById('btn-genius-save') as HTMLButtonElement;
  const confirmModalOverlay = document.getElementById('confirm-modal-overlay') as HTMLDivElement;
  const confirmModalTitle = document.getElementById('confirm-modal-title') as HTMLHeadingElement;
  const confirmModalMessage = document.getElementById('confirm-modal-message') as HTMLDivElement;
  const btnConfirmCancel = document.getElementById('btn-confirm-cancel') as HTMLButtonElement;
  const btnConfirmOk = document.getElementById('btn-confirm-ok') as HTMLButtonElement;
  const noticeModalOverlay = document.getElementById('notice-modal-overlay') as HTMLDivElement;
  const noticeModalTitle = document.getElementById('notice-modal-title') as HTMLHeadingElement;
  const noticeModalMessage = document.getElementById('notice-modal-message') as HTMLDivElement;
  const btnNoticeOk = document.getElementById('btn-notice-ok') as HTMLButtonElement;
  let invalidApiKeyDetected = false;

  // ─── File Table Rendering ────────────────────────────────────────────

  let tableEl: HTMLTableElement | null = null;
  let tbodyEl: HTMLTableSectionElement | null = null;

  function createFileTable(): void {
    if (tableEl) return;

    tableEl = document.createElement('table');
    tableEl.className = 'file-table';
    tableEl.innerHTML = `
      <thead>
        <tr>
          <th class="col-status"></th>
          <th>Filename</th>
          <th>Metadata</th>
          <th class="col-format">Format</th>
          <th class="col-size">Size</th>
          <th class="col-actions"></th>
        </tr>
      </thead>
    `;
    tbodyEl = document.createElement('tbody');
    tableEl.appendChild(tbodyEl);
  }

  function renderFileList(files: ReadonlyArray<FileEntry>): void {
    if (files.length === 0) {
      // Show empty message
      fileListEmpty.style.display = 'flex';
      if (tableEl && fileListEl.contains(tableEl)) {
        fileListEl.removeChild(tableEl);
      }
      fileCountEl.style.display = 'none';
      return;
    }

    // Hide empty message, show table
    fileListEmpty.style.display = 'none';
    fileCountEl.style.display = 'inline';
    fileCountEl.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;

    createFileTable();
    if (tbodyEl) {
      tbodyEl.innerHTML = '';
      for (const file of files) {
        tbodyEl.appendChild(createFileRow(file));
      }
    }

    if (tableEl && !fileListEl.contains(tableEl)) {
      fileListEl.appendChild(tableEl);
    }
  }

  function createFileRow(file: FileEntry): HTMLTableRowElement {
    const tr = document.createElement('tr');
    const statusClass = getStatusCSSClass(file.status);
    const icon = getStatusIcon(file.status);
    const label = getStatusLabel(file.status);

    // For errors, append the failed step to the tooltip so users know which
    // part of the pipeline failed without opening the error modal.
    const stepLabels: Record<string, string> = {
      reading: 'File Read',
      fingerprinting: 'Fingerprinting',
      fetching_metadata: 'Metadata Fetch',
      fetching_album_art: 'Album Art Fetch',
      fetching_lyrics: 'Lyrics Fetch',
      writing_tags: 'Tag Writing',
      unknown: 'Unknown Step',
    };
    const errorTitle =
      file.status === 'error' && file.failedStep
        ? `${label} — failed at: ${stepLabels[file.failedStep] ?? file.failedStep}${file.error ? `\n${file.error}` : ''}`
        : label;

    const metaDisplay = file.metadataLoaded
      ? `${file.currentArtist ?? 'Unknown'} - ${file.currentTitle ?? 'Unknown'}`
      : '<span class="meta-secondary">Loading...</span>';

    tr.innerHTML = `
      <td class="col-status">
        <span class="status-icon ${statusClass}" title="${escapeHtml(errorTitle)}">${icon}</span>
      </td>
      <td title="${escapeHtml(file.filePath)}">${escapeHtml(file.fileName)}</td>
      <td>${metaDisplay}</td>
      <td class="col-format"><span class="format-badge">${escapeHtml(file.formatLabel)}</span></td>
      <td class="col-size">${escapeHtml(file.fileSizeFormatted)}</td>
      <td class="col-actions">
        <button class="remove-btn" data-filepath="${escapeHtml(file.filePath)}" title="Remove">&times;</button>
      </td>
    `;

    // Bind remove button
    const removeBtn = tr.querySelector('.remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        controller.removeFile(file.filePath);
      });
    }

    return tr;
  }

  function getStatusCSSClass(status: string): string {
    switch (status) {
      case 'completed':
        return 'status-completed';
      case 'error':
        return 'status-error';
      case 'skipped':
        return 'status-skipped';
      case 'pending':
        return 'status-pending';
      default:
        return 'status-processing';
    }
  }

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Error Modal Rendering ──────────────────────────────────────────

  function updateErrorButtons(): void {
    const hasErrors = tracker.hasErrors;
    btnViewErrors.classList.toggle('visible', hasErrors);
    btnExportLog.classList.toggle('visible', hasErrors);
  }

  function renderErrorModal(entries: ReadonlyArray<ErrorEntry>, summary: ErrorSummary): void {
    // Update summary text
    if (summary.totalErrors === 0) {
      errorModalSummary.textContent = 'No issues recorded';
    } else {
      const parts: string[] = [`${summary.totalErrors} total`];
      if (summary.failedCount > 0) parts.push(`${summary.failedCount} failed`);
      if (summary.skippedCount > 0) parts.push(`${summary.skippedCount} skipped`);
      errorModalSummary.textContent = parts.join(' \u2022 ');
    }

    // Render error list
    if (entries.length === 0) {
      errorListEmpty.style.display = 'block';
      errorList.style.display = 'none';
    } else {
      errorListEmpty.style.display = 'none';
      errorList.style.display = 'block';
      errorList.innerHTML = '';

      for (const entry of entries) {
        const li = document.createElement('li');
        li.className = 'error-item';

        const iconClass = entry.status === 'error' ? 'icon-error' : 'icon-skipped';
        const iconChar = entry.status === 'error' ? '\u2717' : '\u26A0';

        li.innerHTML = `
          <span class="error-item-icon ${iconClass}">${iconChar}</span>
          <div class="error-item-content">
            <div class="error-item-filename" title="${escapeHtml(entry.filePath)}">${escapeHtml(entry.fileName)}</div>
            <div class="error-item-message">${escapeHtml(entry.message)}</div>
            <div class="error-item-time">${escapeHtml(entry.timestamp)}</div>
          </div>
        `;

        errorList.appendChild(li);
      }
    }
  }

  function updateFilterButtons(state: ErrorModalState): void {
    filterAll.classList.toggle('active', state.filter === 'all');
    filterErrors.classList.toggle('active', state.filter === 'errors');
    filterSkipped.classList.toggle('active', state.filter === 'skipped');

    // Show/hide modal
    errorModalOverlay.classList.toggle('visible', state.isOpen);
  }

  function requestApiKey(): Promise<string | null> {
    apiKeyError.textContent = '';
    apiKeyInput.value = '';
    apiKeyModalOverlay.classList.add('visible');

    window.setTimeout(() => {
      apiKeyInput.focus();
    }, 0);

    return new Promise((resolve) => {
      const cleanup = (): void => {
        btnApiKeySave.removeEventListener('click', onSave);
        btnApiKeyCancel.removeEventListener('click', onCancel);
        apiKeyInput.removeEventListener('keydown', onInputKeyDown);
        apiKeyModalOverlay.removeEventListener('click', onOverlayClick);
        apiKeyModalOverlay.classList.remove('visible');
      };

      const finish = (value: string | null): void => {
        cleanup();
        resolve(value);
      };

      const onSave = (): void => {
        const value = apiKeyInput.value.trim();
        if (!value) {
          apiKeyError.textContent = 'API key is required.';
          apiKeyInput.focus();
          return;
        }
        finish(value);
      };

      const onCancel = (): void => {
        finish(null);
      };

      const onInputKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSave();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      };

      const onOverlayClick = (event: MouseEvent): void => {
        if (event.target === apiKeyModalOverlay) {
          onCancel();
        }
      };

      btnApiKeySave.addEventListener('click', onSave);
      btnApiKeyCancel.addEventListener('click', onCancel);
      apiKeyInput.addEventListener('keydown', onInputKeyDown);
      apiKeyModalOverlay.addEventListener('click', onOverlayClick);
    });
  }

  /**
   * Prompts the user to enter Spotify Client ID and Client Secret.
   * Pre-fills any already-saved credentials.
   * Returns the entered credentials, or null if the user cancelled.
   */
  function requestSpotifyCredentials(
    existingId: string = '',
    existingSecret: string = '',
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    spotifyCredentialError.textContent = '';
    spotifyClientIdInput.value = existingId;
    spotifyClientSecretInput.value = existingSecret;
    spotifyModalOverlay.classList.add('visible');

    window.setTimeout(() => {
      spotifyClientIdInput.focus();
    }, 0);

    return new Promise((resolve) => {
      const cleanup = (): void => {
        btnSpotifySave.removeEventListener('click', onSave);
        btnSpotifyCancel.removeEventListener('click', onCancel);
        spotifyClientIdInput.removeEventListener('keydown', onKeyDown);
        spotifyClientSecretInput.removeEventListener('keydown', onKeyDown);
        spotifyModalOverlay.removeEventListener('click', onOverlayClick);
        spotifyModalOverlay.classList.remove('visible');
      };

      const finish = (value: { clientId: string; clientSecret: string } | null): void => {
        cleanup();
        resolve(value);
      };

      const onSave = (): void => {
        const clientId = spotifyClientIdInput.value.trim();
        const clientSecret = spotifyClientSecretInput.value.trim();
        if (!clientId || !clientSecret) {
          spotifyCredentialError.textContent = 'Both Client ID and Client Secret are required.';
          (clientId ? spotifyClientSecretInput : spotifyClientIdInput).focus();
          return;
        }
        finish({ clientId, clientSecret });
      };

      const onCancel = (): void => {
        finish(null);
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSave();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      };

      const onOverlayClick = (event: MouseEvent): void => {
        if (event.target === spotifyModalOverlay) {
          onCancel();
        }
      };

      btnSpotifySave.addEventListener('click', onSave);
      btnSpotifyCancel.addEventListener('click', onCancel);
      spotifyClientIdInput.addEventListener('keydown', onKeyDown);
      spotifyClientSecretInput.addEventListener('keydown', onKeyDown);
      spotifyModalOverlay.addEventListener('click', onOverlayClick);
    });
  }

  function requestConfirmation(
    title: string,
    message: string,
    confirmLabel: string = 'Confirm',
  ): Promise<boolean> {
    confirmModalTitle.textContent = title;
    confirmModalMessage.textContent = message;
    btnConfirmOk.textContent = confirmLabel;
    confirmModalOverlay.classList.add('visible');

    window.setTimeout(() => {
      btnConfirmOk.focus();
    }, 0);

    return new Promise((resolve) => {
      const cleanup = (): void => {
        btnConfirmOk.removeEventListener('click', onConfirm);
        btnConfirmCancel.removeEventListener('click', onCancel);
        confirmModalOverlay.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onKeyDown);
        confirmModalOverlay.classList.remove('visible');
      };

      const finish = (result: boolean): void => {
        cleanup();
        resolve(result);
      };

      const onConfirm = (): void => {
        finish(true);
      };

      const onCancel = (): void => {
        finish(false);
      };

      const onOverlayClick = (event: MouseEvent): void => {
        if (event.target === confirmModalOverlay) {
          onCancel();
        }
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (!confirmModalOverlay.classList.contains('visible')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          onConfirm();
        }
      };

      btnConfirmOk.addEventListener('click', onConfirm);
      btnConfirmCancel.addEventListener('click', onCancel);
      confirmModalOverlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeyDown);
    });
  }

  function showNotice(title: string, message: string): Promise<void> {
    noticeModalTitle.textContent = title;
    noticeModalMessage.textContent = message;
    noticeModalOverlay.classList.add('visible');

    window.setTimeout(() => {
      btnNoticeOk.focus();
    }, 0);

    return new Promise((resolve) => {
      const cleanup = (): void => {
        btnNoticeOk.removeEventListener('click', onClose);
        noticeModalOverlay.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onKeyDown);
        noticeModalOverlay.classList.remove('visible');
      };

      const onClose = (): void => {
        cleanup();
        resolve();
      };

      const onOverlayClick = (event: MouseEvent): void => {
        if (event.target === noticeModalOverlay) {
          onClose();
        }
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (!noticeModalOverlay.classList.contains('visible')) return;
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault();
          onClose();
        }
      };

      btnNoticeOk.addEventListener('click', onClose);
      noticeModalOverlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeyDown);
    });
  }

  function isInvalidApiKeyError(error: string | null | undefined): boolean {
    if (!error) return false;
    return error.toLowerCase().includes('invalid api key');
  }

  // ─── ProgressTracker Event Listeners ─────────────────────────────────

  tracker.onEntriesChange((entries, summary) => {
    renderErrorModal(entries, summary);
    updateErrorButtons();
  });

  tracker.onModalStateChange((state) => {
    updateFilterButtons(state);
    // Re-render entries with current filter when modal opens or filter changes
    renderErrorModal(tracker.getFilteredEntries(), tracker.getSummary());
  });

  // ─── UI State Updates ────────────────────────────────────────────────

  controller.onStateChange((uiState) => {
    btnSelectFiles.disabled = !uiState.selectFilesEnabled;
    btnSelectFolder.disabled = !uiState.selectFolderEnabled;
    btnStart.disabled = !uiState.startEnabled;
    btnClear.disabled = !uiState.clearEnabled;

    // Show/hide cancel button
    btnCancel.style.display = uiState.cancelEnabled ? 'inline-block' : 'none';
    btnStart.style.display = uiState.cancelEnabled ? 'none' : 'inline-block';

    // Update status bar
    statusText.textContent = uiState.statusText;

    // Show/hide empty message
    if (uiState.showEmptyMessage) {
      fileListEmpty.style.display = 'flex';
    }
  });

  controller.onFileListChange((files) => {
    renderFileList(files);
  });

  controller.onProgress((progress) => {
    // Show progress area
    progressArea.classList.add('visible');
    progressBar.style.width = `${progress.percentage}%`;
    progressPercentage.textContent = `${progress.percentage}%`;

    if (progress.currentFile) {
      progressLabel.textContent = `Processing: ${progress.currentFile} (${progress.processedFiles}/${progress.totalFiles})`;
    } else {
      progressLabel.textContent = `Processing: ${progress.processedFiles}/${progress.totalFiles}`;
    }

    statSuccess.textContent = `${progress.successCount} succeeded`;
    statError.textContent = `${progress.errorCount} failed`;
    statSkipped.textContent = `${progress.skippedCount} skipped`;
  });

  controller.onProcessingComplete(() => {
    progressLabel.textContent = 'Processing complete';
    updateErrorButtons();
  });

  // ─── Button Event Handlers ───────────────────────────────────────────

  btnSelectFiles.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      controller.setLoadingFiles();
      try {
        const filePaths: string[] = await window.electronAPI.selectFiles();
        controller.handleFilesSelected(filePaths);

        // Load metadata for new files
        for (const fp of filePaths) {
          try {
            const meta = (await window.electronAPI.getFileMetadata(fp)) as {
              title?: string | null;
              artist?: string | null;
              fileSize?: number;
            } | null;
            if (meta) {
              controller.handleMetadataLoaded(fp, meta);
            }
          } catch {
            // Metadata load failure is non-fatal
          }
        }
      } catch {
        controller.setIdle();
      }
    })();
  });

  btnSelectFolder.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      controller.setLoadingFiles();
      try {
        const filePaths: string[] = await window.electronAPI.selectFolder();
        controller.handleFilesSelected(filePaths);

        // Load metadata for new files
        for (const fp of filePaths) {
          try {
            const meta = (await window.electronAPI.getFileMetadata(fp)) as {
              title?: string | null;
              artist?: string | null;
              fileSize?: number;
            } | null;
            if (meta) {
              controller.handleMetadataLoaded(fp, meta);
            }
          } catch {
            // Metadata load failure is non-fatal
          }
        }
      } catch {
        controller.setIdle();
      }
    })();
  });

  btnStart.addEventListener('click', (): void => {
    // Clear previous error entries before new processing run
    tracker.clear();
    updateErrorButtons();

    void (async (): Promise<void> => {
      // Ensure an AcoustID API key is configured before processing
      const currentSettings = (await window.electronAPI.getSettings()) as AppSettings | null;
      let apiKey = currentSettings?.acoustIdApiKey?.trim() ?? '';

      if (!apiKey) {
        const enteredKey = await requestApiKey();
        if (!enteredKey) {
          // User cancelled or entered nothing — abort
          controller.setIdle();
          return;
        }
        apiKey = enteredKey;
        // Persist the key for future sessions
        await window.electronAPI.saveSettings({ acoustIdApiKey: apiKey });
      }

      const filePaths = controller.startProcessing();

      try {
        await window.electronAPI.startProcessing(filePaths);
      } catch {
        // Error will be reported via IPC completion event
      }
    })();
  });

  btnCancel.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      try {
        await window.electronAPI.cancelProcessing();
      } catch {
        // Cancel failure is non-critical
      }
    })();
  });

  btnClear.addEventListener('click', () => {
    controller.clearFiles();
    tracker.clear();
    progressArea.classList.remove('visible');
    updateErrorButtons();
  });

  btnClearCache.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      const confirmed = await requestConfirmation(
        'Clear Cache',
        'Clear all cached fingerprints, metadata, and lyrics? This cannot be undone.',
        'Clear Cache',
      );
      if (!confirmed) {
        return;
      }

      try {
        await window.electronAPI.clearCache();
        await showNotice('Cache Cleared', 'Cache cleared successfully.');
      } catch (error) {
        await showNotice(
          'Clear Cache Failed',
          `Failed to clear cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  });

  // ─── Spotify Toggle & Credential Handlers ───────────────────────────

  /** Sync the Configure button visibility with the checkbox state */
  function updateSpotifyConfigButton(): void {
    btnSpotifyConfig.style.display = spotifyEnabledCheckbox.checked ? 'inline-block' : 'none';
  }

  /** Load saved Spotify settings and reflect them in the UI */
  async function initSpotifyUi(): Promise<void> {
    try {
      const saved = (await window.electronAPI.getSettings()) as AppSettings | null;
      if (saved?.useSpotify) {
        spotifyEnabledCheckbox.checked = true;
      }
    } catch {
      // Non-fatal — leave checkbox unchecked
    }
    updateSpotifyConfigButton();
  }

  spotifyEnabledCheckbox.addEventListener('change', (): void => {
    void (async (): Promise<void> => {
      if (spotifyEnabledCheckbox.checked) {
        // Fetch existing credentials (pre-fill if already saved)
        let existingId = '';
        let existingSecret = '';
        try {
          const saved = (await window.electronAPI.getSettings()) as AppSettings | null;
          existingId = saved?.spotifyClientId ?? '';
          existingSecret = saved?.spotifyClientSecret ?? '';
        } catch {
          // Ignore — will prompt with empty fields
        }

        // If credentials are already configured, just enable
        if (existingId && existingSecret) {
          await window.electronAPI.saveSettings({ useSpotify: true });
          updateSpotifyConfigButton();
          return;
        }

        // No credentials yet — prompt for them
        const result = await requestSpotifyCredentials(existingId, existingSecret);
        if (result) {
          await window.electronAPI.saveSettings({
            useSpotify: true,
            spotifyClientId: result.clientId,
            spotifyClientSecret: result.clientSecret,
          });
          updateSpotifyConfigButton();
        } else {
          // User cancelled — revert checkbox
          spotifyEnabledCheckbox.checked = false;
          updateSpotifyConfigButton();
        }
      } else {
        // Unchecked — disable Spotify (keep credentials saved for convenience)
        await window.electronAPI.saveSettings({ useSpotify: false });
        updateSpotifyConfigButton();
      }
    })();
  });

  btnSpotifyConfig.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      let existingId = '';
      let existingSecret = '';
      try {
        const saved = (await window.electronAPI.getSettings()) as AppSettings | null;
        existingId = saved?.spotifyClientId ?? '';
        existingSecret = saved?.spotifyClientSecret ?? '';
      } catch {
        // Ignore
      }

      const result = await requestSpotifyCredentials(existingId, existingSecret);
      if (result) {
        await window.electronAPI.saveSettings({
          spotifyClientId: result.clientId,
          spotifyClientSecret: result.clientSecret,
        });
      }
    })();
  });

  // ─── Genius Toggle & Credential Handlers ────────────────────────────

  function updateGeniusConfigButton(): void {
    btnGeniusConfig.style.display = geniusEnabledCheckbox.checked ? 'inline-block' : 'none';
  }

  async function initGeniusUi(): Promise<void> {
    try {
      const saved = (await window.electronAPI.getSettings()) as AppSettings | null;
      if (saved?.useGenius) geniusEnabledCheckbox.checked = true;
    } catch {
      // Non-fatal
    }
    updateGeniusConfigButton();
  }

  function requestGeniusToken(existingToken: string = ''): Promise<string | null> {
    geniusTokenError.textContent = '';
    geniusTokenInput.value = existingToken;
    geniusModalOverlay.classList.add('visible');
    window.setTimeout(() => geniusTokenInput.focus(), 0);

    return new Promise((resolve) => {
      const cleanup = (): void => {
        btnGeniusSave.removeEventListener('click', onSave);
        btnGeniusCancel.removeEventListener('click', onCancel);
        geniusTokenInput.removeEventListener('keydown', onKeyDown);
        geniusModalOverlay.removeEventListener('click', onOverlayClick);
        geniusModalOverlay.classList.remove('visible');
      };

      const finish = (value: string | null): void => {
        cleanup();
        resolve(value);
      };

      const onSave = (): void => {
        const token = geniusTokenInput.value.trim();
        if (!token) {
          geniusTokenError.textContent = 'Access token is required.';
          geniusTokenInput.focus();
          return;
        }
        finish(token);
      };

      const onCancel = (): void => finish(null);

      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSave();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      };

      const onOverlayClick = (event: MouseEvent): void => {
        if (event.target === geniusModalOverlay) onCancel();
      };

      btnGeniusSave.addEventListener('click', onSave);
      btnGeniusCancel.addEventListener('click', onCancel);
      geniusTokenInput.addEventListener('keydown', onKeyDown);
      geniusModalOverlay.addEventListener('click', onOverlayClick);
    });
  }

  geniusEnabledCheckbox.addEventListener('change', (): void => {
    void (async (): Promise<void> => {
      if (geniusEnabledCheckbox.checked) {
        let existingToken = '';
        try {
          const saved = (await window.electronAPI.getSettings()) as AppSettings | null;
          existingToken = saved?.geniusAccessToken ?? '';
        } catch {
          // Ignore
        }

        if (existingToken) {
          await window.electronAPI.saveSettings({ useGenius: true });
          updateGeniusConfigButton();
          return;
        }

        const token = await requestGeniusToken();
        if (token) {
          await window.electronAPI.saveSettings({ useGenius: true, geniusAccessToken: token });
          updateGeniusConfigButton();
        } else {
          geniusEnabledCheckbox.checked = false;
          updateGeniusConfigButton();
        }
      } else {
        await window.electronAPI.saveSettings({ useGenius: false });
        updateGeniusConfigButton();
      }
    })();
  });

  btnGeniusConfig.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      let existingToken = '';
      try {
        const saved = (await window.electronAPI.getSettings()) as AppSettings | null;
        existingToken = saved?.geniusAccessToken ?? '';
      } catch {
        // Ignore
      }
      const token = await requestGeniusToken(existingToken);
      if (token) {
        await window.electronAPI.saveSettings({ geniusAccessToken: token });
      }
    })();
  });

  // ─── Error Modal Button Handlers ────────────────────────────────────

  btnViewErrors.addEventListener('click', () => {
    tracker.openModal();
  });

  btnExportLog.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      try {
        await window.electronAPI.exportErrorLog();
      } catch {
        // Export failure is non-critical
      }
    })();
  });

  btnModalClose.addEventListener('click', () => {
    tracker.closeModal();
  });

  btnModalCloseFooter.addEventListener('click', () => {
    tracker.closeModal();
  });

  btnModalExport.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      try {
        await window.electronAPI.exportErrorLog();
      } catch {
        // Export failure is non-critical
      }
    })();
  });

  // Close modal when clicking overlay (outside modal)
  errorModalOverlay.addEventListener('click', (event) => {
    if (event.target === errorModalOverlay) {
      tracker.closeModal();
    }
  });

  // Filter buttons
  filterAll.addEventListener('click', () => {
    tracker.setFilter('all');
  });

  filterErrors.addEventListener('click', () => {
    tracker.setFilter('errors');
  });

  filterSkipped.addEventListener('click', () => {
    tracker.setFilter('skipped');
  });

  // ─── IPC Event Listeners from Main Process ───────────────────────────

  window.electronAPI.onProgressUpdate((data) => {
    controller.handleProgressUpdate(data as ProgressUpdate);
  });

  window.electronAPI.onProcessingComplete((data) => {
    void (async (): Promise<void> => {
      const results = data as ProcessingResult[];
      controller.handleProcessingComplete(results);
      // Record all results in tracker (only errors/skipped are kept)
      tracker.recordResults(results);
      updateErrorButtons();

      const hasInvalidKey =
        invalidApiKeyDetected ||
        results.some((result) => result.status === 'error' && isInvalidApiKeyError(result.error));

      if (hasInvalidKey) {
        invalidApiKeyDetected = false;
        await window.electronAPI.saveSettings({ acoustIdApiKey: '' });
        await showNotice(
          'Invalid AcoustID API Key',
          'The saved AcoustID key was rejected by the API.\n\nUse an AcoustID application client key (not your account login token), then start processing again.',
        );
      }
    })();
  });

  window.electronAPI.onFileComplete((data) => {
    const result = data as ProcessingResult;
    controller.handleFileComplete(result);
    // Record individual result in tracker for real-time error display
    tracker.recordSingleResult(result);
    updateErrorButtons();

    if (
      result.status === 'error' &&
      isInvalidApiKeyError(result.error) &&
      !invalidApiKeyDetected
    ) {
      invalidApiKeyDetected = true;
      void window.electronAPI.cancelProcessing();
    }
  });

  // Initialize Spotify UI from saved settings
  void initSpotifyUi();
  // Initialize Genius UI from saved settings
  void initGeniusUi();

  // eslint-disable-next-line no-console
  console.log('Audio Pipeline renderer initialized');
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);
