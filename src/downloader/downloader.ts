'use strict';

// ── Element refs ─────────────────────────────────────────────────────────────
const introSection       = document.getElementById('intro-section');
const downloadingSection = document.getElementById('downloading-section');
const countLine          = document.getElementById('count-line');
const btnDownload        = document.getElementById('btn-download');
const btnRequired        = document.getElementById('btn-required');
const btnSkip            = document.getElementById('btn-skip');
const btnBackground      = document.getElementById('btn-background');
const progressSection    = document.getElementById('progress-section');
const textureName        = document.getElementById('texture-name');
const textureCount       = document.getElementById('texture-count');
const barOverall         = document.getElementById('bar-overall');
const fileBars = {
  diff: { bar: document.getElementById('bar-diff'), size: document.getElementById('size-diff') },
  disp: { bar: document.getElementById('bar-disp'), size: document.getElementById('size-disp') },
  nor:  { bar: document.getElementById('bar-nor'),  size: document.getElementById('size-nor')  },
  arm:  { bar: document.getElementById('bar-arm'),  size: document.getElementById('size-arm')  },
};
const btnCancel       = document.getElementById('btn-cancel');
const completeSection = document.getElementById('complete-section');
const completeText    = document.getElementById('complete-text');
const failedList      = document.getElementById('failed-list');
const btnClose        = document.getElementById('btn-close');
const errorMsg        = document.getElementById('error-msg');

// ── State ─────────────────────────────────────────────────────────────────────
let eventSource = null;
let total = 0;

// Shared broadcast channel — used to relay progress to the editor toolbar.
const bc = new BroadcastChannel('mapwright');

// ── Startup: check status, attach to ongoing download if one is running ───────
fetch('/api/textures/status')
  .then(r => r.json())
  .then(({ count, requiredCount, downloadInProgress }) => {
    if (downloadInProgress) {
      // A download is already running — connect to it and show progress.
      showDownloading();
      textureName.textContent = 'Connecting…';
      progressSection.classList.add('visible');
      openEventSource('/api/textures/download');
    } else {
      // Normal startup: show intro and configure buttons.
      countLine.textContent = 'High-quality PBR textures from Polyhaven (CC0 licensed)';
      btnDownload.disabled = false;
      if (count >= requiredCount) {
        btnRequired.style.display = 'none';
      } else {
        btnRequired.disabled = false;
        btnRequired.textContent = `Required Only (${requiredCount})`;
      }
    }
  })
  .catch(() => {
    countLine.textContent = 'Could not reach server.';
  });

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatBytes(b) {
  if (!b) return '—';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function resetFileBars() {
  for (const { bar, size } of Object.values(fileBars)) {
    bar.style.width = '0%';
    size.textContent = '—';
  }
}

function setOverall(index, tot) {
  const pct = tot > 0 ? Math.round((index / tot) * 100) : 0;
  barOverall.style.width = pct + '%';
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}

function showIntro() {
  introSection.style.display = '';
  downloadingSection.style.display = 'none';
}

function showDownloading() {
  introSection.style.display = 'none';
  downloadingSection.style.display = '';
}

// ── SSE event handler (shared between new downloads and re-attach) ────────────
function openEventSource(url) {
  eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case 'fetching_catalog':
        textureName.textContent = 'Fetching Polyhaven catalog…';
        break;

      case 'start':
        total = msg.total;
        textureName.textContent = 'Starting download…';
        textureCount.textContent = `0 / ${total}`;
        setOverall(0, total);
        bc.postMessage({ type: 'download-start', total });
        break;

      case 'texture_start':
        resetFileBars();
        textureName.textContent = msg.name;
        textureCount.textContent = `${msg.index + 1} / ${msg.total}`;
        break;

      case 'file_start':
        if (fileBars[msg.file]) {
          fileBars[msg.file].bar.style.width = '0%';
          fileBars[msg.file].size.textContent = 'Downloading…';
        }
        break;

      case 'file_progress':
        if (fileBars[msg.file]) {
          const pct = msg.totalBytes > 0
            ? Math.round((msg.bytesReceived / msg.totalBytes) * 100)
            : 0;
          fileBars[msg.file].bar.style.width = pct + '%';
          fileBars[msg.file].size.textContent = msg.totalBytes > 0
            ? `${formatBytes(msg.bytesReceived)} / ${formatBytes(msg.totalBytes)}`
            : formatBytes(msg.bytesReceived);
        }
        break;

      case 'file_done':
        if (fileBars[msg.file]) {
          if (msg.status === 'failed') {
            fileBars[msg.file].bar.style.width = '0%';
            fileBars[msg.file].size.textContent = 'Failed';
          } else if (msg.status === 'exists') {
            fileBars[msg.file].bar.style.width = '100%';
            fileBars[msg.file].size.textContent = `${formatBytes(msg.totalBytes)} (exists)`;
          } else if (msg.status === 'unavailable') {
            fileBars[msg.file].size.textContent = 'N/A';
          }
        }
        break;

      case 'texture_done':
        setOverall(msg.index + 1, msg.total);
        bc.postMessage({ type: 'download-progress', index: msg.index + 1, total: msg.total });
        break;

      case 'complete':
        eventSource.close();
        eventSource = null;
        bc.postMessage({ type: 'textures-downloaded' });
        progressSection.classList.remove('visible');
        downloadingSection.style.display = 'none';
        completeText.textContent =
          `Download complete! ${msg.downloaded} downloaded, ${msg.skipped} already existed${msg.failed > 0 ? `, ${msg.failed} failed` : ''}.`;
        if (msg.failures && msg.failures.length) {
          console.error('[Textures] Failed textures:', msg.failures);
          failedList.innerHTML = '<div class="failed-label">Failed textures:</div>' +
            msg.failures.map(f => `<div class="failed-item">${f.name} — ${f.reason}</div>`).join('');
        }
        completeSection.classList.add('visible');
        break;

      case 'cancelled':
        eventSource.close();
        eventSource = null;
        bc.postMessage({ type: 'download-cancelled' });
        progressSection.classList.remove('visible');
        showIntro();
        textureName.textContent = '';
        textureCount.textContent = '';
        setOverall(0, 1);
        resetFileBars();
        break;

      case 'error':
        eventSource.close();
        eventSource = null;
        showIntro();
        progressSection.classList.remove('visible');
        showError(`Download error: ${msg.error}`);
        break;
    }
  };

  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    showIntro();
    progressSection.classList.remove('visible');
    showError('Connection lost. Check your internet connection and try again.');
  };
}

// ── Download ──────────────────────────────────────────────────────────────────
function startDownload(mode) {
  showDownloading();
  progressSection.classList.add('visible');
  textureName.textContent = 'Fetching catalog…';
  textureCount.textContent = '';

  const url = mode === 'required'
    ? '/api/textures/download?mode=required'
    : '/api/textures/download';

  openEventSource(url);
}

// ── Event listeners ───────────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => startDownload('all'));
btnRequired.addEventListener('click', () => startDownload('required'));

btnSkip.addEventListener('click', () => window.close());
btnClose.addEventListener('click', () => window.close());
btnBackground.addEventListener('click', () => window.close());

// Cancel stops the server-side download, notifies the editor toolbar, and closes the window.
btnCancel.addEventListener('click', () => {
  fetch('/api/textures/cancel', { method: 'POST' });
  bc.postMessage({ type: 'download-cancelled' });
  window.close();
});
