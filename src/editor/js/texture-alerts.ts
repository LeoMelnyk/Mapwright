/**
 * Texture download status alert button UI.
 *
 * Manages the toolbar button that shows texture download progress,
 * missing-texture warnings, and new-texture-available notifications.
 *
 * @module texture-alerts
 */

/**
 * Wire up the texture alert button, BroadcastChannel listener, and polling.
 *
 * @param {Function} reloadAssets  - re-fetches all asset catalogs after download
 * @param {Function} renderTexturesPanel - refreshes the textures panel UI
 * @returns {void}
 */
export function initTextureAlerts(reloadAssets: () => Promise<void>, renderTexturesPanel: () => void): void {
  // Texture alert button: three states driven by /api/textures/status.
  //  - count < requiredCount          → "Missing Textures" (amber)
  //  - count >= required, count < cat → "New Textures Available" (teal)
  //  - otherwise                      → hidden
  const btnTextureAlert = document.getElementById('btn-texture-alert')!;

  function _updateAlertBtn({ count, requiredCount, catalogCount, downloadInProgress, downloadSnapshot }: { count: number; requiredCount: number; catalogCount: number; downloadInProgress: boolean; downloadSnapshot: { index: number; total: number } | null }) {
    if (downloadInProgress) {
      if (!btnTextureAlert.classList.contains('downloading')) {
        btnTextureAlert.style.display = 'inline-flex';
        btnTextureAlert.classList.add('downloading');
        btnTextureAlert.style.setProperty('--dl-pct', '0%');
        btnTextureAlert.innerHTML = '<span>Downloading 0%</span>';
      }
      if (downloadSnapshot?.index !== undefined && downloadSnapshot.total) {
        const pct = Math.round((downloadSnapshot.index / downloadSnapshot.total) * 100);
        btnTextureAlert.style.setProperty('--dl-pct', `${pct}%`);
        const span = btnTextureAlert.querySelector('span');
        if (span) span.textContent = `Downloading ${pct}%`;
      }
      _startDlPolling();
      return;
    }
    _stopDlPolling();
    btnTextureAlert.classList.remove('new-available');
    const label = btnTextureAlert.querySelector('.alert-label');
    if (count < requiredCount) {
      btnTextureAlert.title = 'Some required textures are missing — click to download';
      if (label) label.textContent = 'Missing Textures';
      btnTextureAlert.style.display = 'inline-flex';
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (catalogCount !== null && count < catalogCount) {
      btnTextureAlert.classList.add('new-available');
      btnTextureAlert.title = 'New textures are available on Polyhaven — click to download';
      if (label) label.textContent = 'New Textures Available';
      btnTextureAlert.style.display = 'inline-flex';
    } else {
      btnTextureAlert.style.display = 'none';
    }
  }

  function _fetchAndUpdateAlert(retriesLeft = 12) {
    fetch('/api/textures/status')
      .then(r => r.json())
      .then(status => {
        _updateAlertBtn(status);
        // catalogCount comes from a background server fetch of the Polyhaven catalog.
        // If it's not resolved yet, retry every 1.5 s until it is (or retries run out).
        if (retriesLeft > 0 && status.catalogCount === null && status.count >= status.requiredCount) {
          setTimeout(() => _fetchAndUpdateAlert(retriesLeft - 1), 1500);
        }
      })
      .catch(() => {});
  }

  _fetchAndUpdateAlert();

  btnTextureAlert.addEventListener('click', () => {
    // Named target — if the downloader window is already open it gets focused
    // instead of opening a new one.
    window.open(
      `${location.protocol}//${location.host}/downloader/`,
      'mapwright-downloader',
      'width=520,height=520,resizable=no'
    );
  });

  // Transform the toolbar button into a live progress bar while downloading
  // in the background, and reload assets automatically when done.
  const _alertBtnOrigHTML = btnTextureAlert.innerHTML;

  let _dlPollInterval: ReturnType<typeof setInterval> | null = null;
  function _startDlPolling() {
    if (_dlPollInterval) return;
    _dlPollInterval = setInterval(() => {
      fetch('/api/textures/status')
        .then(r => r.json())
        .then(status => { _updateAlertBtn(status); })
        .catch(() => {});
    }, 1500);
  }
  function _stopDlPolling() {
    if (_dlPollInterval) { clearInterval(_dlPollInterval); _dlPollInterval = null; }
  }

  function _resetAlertBtn() {
    btnTextureAlert.classList.remove('downloading', 'new-available');
    btnTextureAlert.style.removeProperty('--dl-pct');
    btnTextureAlert.innerHTML = _alertBtnOrigHTML;
  }

  function _recheckAlertBtn() {
    _fetchAndUpdateAlert(12);
  }

  const _bc = new BroadcastChannel('mapwright');
  _bc.addEventListener('message', ({ data }) => { void (async () => {
    if (data?.type === 'download-start') {
      btnTextureAlert.style.display = 'inline-flex';
      btnTextureAlert.classList.add('downloading');
      btnTextureAlert.style.setProperty('--dl-pct', '0%');
      btnTextureAlert.innerHTML = '<span>Downloading 0%</span>';
      _startDlPolling();

    } else if (data?.type === 'download-progress') {
      const pct = Math.round((data.index / data.total) * 100);
      btnTextureAlert.style.setProperty('--dl-pct', `${pct}%`);
      const span = btnTextureAlert.querySelector('span');
      if (span) span.textContent = `Downloading ${pct}%`;

    } else if (data?.type === 'download-cancelled') {
      _stopDlPolling();
      _resetAlertBtn();
      // The server may still be finishing the current texture — poll until it confirms
      // the cancel before updating the button (avoids re-entering downloading mode).
      const _waitCancel = setInterval(() => {
        fetch('/api/textures/status')
          .then(r => r.json())
          .then(status => {
            if (!status.downloadInProgress) {
              clearInterval(_waitCancel);
              _updateAlertBtn(status);
            }
          })
          .catch(() => {});
      }, 500);

    } else if (data?.type === 'textures-downloaded') {
      _stopDlPolling();
      _resetAlertBtn();
      await reloadAssets();
      renderTexturesPanel();
      _recheckAlertBtn();
    }
  })(); });
}
