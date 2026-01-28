'use strict';

const DfuFileCheckResult = {
  ok: 0,
  emptyFileName: 1,
  unsupportedFileType: 2,
  fileNameError: 3,
  deviceHwTypeMismatch: 5,
  deviceHwVersionUnknown: 6,
  deviceHwVersionMismatch: 7,
  fileHwVersionFormatError: 8,
  deviceFwTypeMismatch: 10,
  deviceFwVersionUnknown: 11,
  deviceFwVersionMismatch: 12,
  fileFwVersionFormatError: 13,
  deviceCannotUpgradeToSix: 14,
};

const FileNameHwEnum = {
  0: 'default',
  1: 'rhinoedge_nrf52840',
  2: 'elephantedge_nrf52840',
  3: 'wisentedge_nrf52840',
  4: 'cattracker_nrf52840',
  5: 'rangeredge_nrf52840',
  6: 'rhinopuck_nrf52840',
};

const FileNameFwEnum = {
  0: 'default',
  1: 'rhinoedge_tracker',
  2: 'elephantedge_tracker',
  3: 'wisentedge_tracker',
  4: 'cattracker_tracker',
  5: 'rangeredge_tracker',
  6: 'rhinopuck_tracker',
};

const HwTypeEnum = {
  unknown: 255,
};

const FwTypeEnum = {
  default: 0,
};

const dfuCheckMessages = {
  [DfuFileCheckResult.ok]: 'DFU file looks good for this device.',
  [DfuFileCheckResult.emptyFileName]: 'Select a DFU file before continuing.',
  [DfuFileCheckResult.unsupportedFileType]: 'Unsupported DFU file type. Use a .bin or .zip file.',
  [DfuFileCheckResult.fileNameError]: 'DFU file name format is not recognized.',
  [DfuFileCheckResult.deviceHwTypeMismatch]: 'Hardware type does not match the connected device.',
  [DfuFileCheckResult.deviceHwVersionUnknown]: 'Device hardware version is unknown.',
  [DfuFileCheckResult.deviceHwVersionMismatch]: 'Hardware version does not match the connected device.',
  [DfuFileCheckResult.fileHwVersionFormatError]: 'Hardware version in the file name is invalid.',
  [DfuFileCheckResult.deviceFwTypeMismatch]: 'Firmware type does not match the connected device.',
  [DfuFileCheckResult.deviceFwVersionUnknown]: 'Device firmware version is unknown.',
  [DfuFileCheckResult.deviceFwVersionMismatch]: 'Firmware version in the file is older than the device.',
  [DfuFileCheckResult.fileFwVersionFormatError]: 'Firmware version in the file name is invalid.',
  [DfuFileCheckResult.deviceCannotUpgradeToSix]: 'This device cannot be upgraded to 6.0 or newer firmware.',
};

const dfuState = {
  deviceInfo: null,
  file: null,
  fileData: null,
  checkResult: DfuFileCheckResult.emptyFileName,
  connected: false,
  uploadReady: false,
  mcumgr: null,
  existingDevice: null,
  useExistingConnection: false,
  pendingImageState: null,
  imageStateSilent: false,
};

let elements = null;

function bindElements() {
  elements = {
    deviceName: document.getElementById('dfu-device-name'),
    deviceHw: document.getElementById('dfu-device-hw'),
    deviceFw: document.getElementById('dfu-device-fw'),
    deviceUpdated: document.getElementById('dfu-device-updated'),
    deviceWarning: document.getElementById('dfu-device-warning'),
    fileInput: document.getElementById('dfu-file'),
    fileStatus: document.getElementById('dfu-file-status'),
    checkStatus: document.getElementById('dfu-check-status'),
    continueButton: document.getElementById('dfu-continue'),
    uploadSection: document.getElementById('dfu-upload-section'),
    uploadButton: document.getElementById('dfu-upload'),
    cancelButton: document.getElementById('dfu-cancel'),
    progressBar: document.getElementById('dfu-progress-bar'),
    progressText: document.getElementById('dfu-progress-text'),
    mainLog: document.getElementById('log'),
    disconnectButton: document.getElementById('dfu-disconnect'),
    connectionStatus: document.getElementById('dfu-connection-status'),
    uploadStatusList: document.getElementById('dfu-upload-status-list'),
  };
  return elements;
}

function logDfu(message, isError = false) {
  if (!elements || !elements.mainLog) return;
  const line = document.createElement('div');
  line.textContent = `DFU: ${message}`;
  line.classList.add('log-entry');
  if (isError) {
    line.classList.add('error');
  }
  elements.mainLog.appendChild(line);
  elements.mainLog.scrollTop = elements.mainLog.scrollHeight;
}

function updateUploadStatus(step, state, detail = '') {
  if (!elements || !elements.uploadStatusList) return;
  const item = elements.uploadStatusList.querySelector(`[data-step="${step}"]`);
  if (!item) return;
  item.classList.remove('active', 'completed', 'error');
  if (state && state !== 'pending') {
    item.classList.add(state);
  }
  const detailSpan = item.querySelector('.status-detail');
  if (detailSpan) {
    detailSpan.textContent = detail;
  }
}

function resetUploadStatus(keepFile = false) {
  if (!elements || !elements.uploadStatusList) return;
  const items = Array.from(elements.uploadStatusList.querySelectorAll('li'));
  items.forEach(item => {
    const step = item.getAttribute('data-step');
    if (keepFile && step === 'file') {
      return;
    }
    item.classList.remove('active', 'completed', 'error');
    const detailSpan = item.querySelector('.status-detail');
    if (detailSpan) {
      detailSpan.textContent = '';
    }
  });
}

function readDeviceInfo() {
  const stored = sessionStorage.getItem('dfuDeviceInfo');
  if (!stored) {
    return null;
  }
  try {
    return JSON.parse(stored);
  } catch (error) {
    return null;
  }
}

function formatUpdatedAt(timestamp) {
  if (!timestamp) {
    return 'Not available';
  }
  const date = new Date(timestamp);
  return date.toLocaleString('nl-NL');
}

function renderDeviceInfo(info) {
  if (!elements) return;
  if (!info) {
    elements.deviceName.textContent = 'Unknown';
    elements.deviceHw.textContent = 'Unknown';
    elements.deviceFw.textContent = 'Unknown';
    elements.deviceUpdated.textContent = 'Not available';
    elements.deviceWarning.classList.remove('hidden');
    return;
  }

  elements.deviceWarning.classList.add('hidden');
  elements.deviceName.textContent = info.deviceName || 'Unknown';
  elements.deviceHw.textContent = `${info.hwTypeLabel || 'Unknown'} (v${info.hwVersion || '?'})`;
  elements.deviceFw.textContent = `v${info.fwVersion || '?'} (type ${info.fwTypeLabel || 'unknown'})`;
  elements.deviceUpdated.textContent = formatUpdatedAt(info.updatedAt);
}

function checkFilenameBasic(fileName) {
  const trimmed = String(fileName || '').trim();
  if (!trimmed) {
    return DfuFileCheckResult.emptyFileName;
  }
  const lower = trimmed.toLowerCase();
  const parts = lower.split('-');
  if (parts.length < 5) {
    return DfuFileCheckResult.fileNameError;
  }
  const last = parts[parts.length - 1];
  const ext = last.split('.').pop();
  if (!ext || !['bin', 'zip'].includes(ext)) {
    return DfuFileCheckResult.unsupportedFileType;
  }
  return DfuFileCheckResult.ok;
}

function versionCompare(versionA, versionB) {
  const a = String(versionA || '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const b = String(versionB || '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

function checkDfuFileName(fileName, deviceType, deviceFwVersion, deviceHwType, deviceHwVersion) {
  const basic = checkFilenameBasic(fileName);
  if (basic !== 0) {
    return basic;
  }

  const fileNameArray = fileName.toLowerCase().split('-');
  const fileArrayLength = fileNameArray.length;
  const fwVerOrQualifierArray = fileNameArray[fileArrayLength - 1].split('.');
  const indexOfFileType = fwVerOrQualifierArray.length - 1;
  const fileType = fwVerOrQualifierArray[indexOfFileType];

  let fileHwType = '';
  let fileHwVersion = '';
  let fileFwType = '';
  let fileFwVersion = '';

  if (fileNameArray[1] === 'app') {
    fileFwType = fileNameArray[0];
    fileHwType = fileNameArray[2];
    fileHwVersion = fileNameArray[3];
    fileFwVersion = fileNameArray[4];
  } else if (fileNameArray[1] === 'collar') {
    fileFwType = 'default';
    fileHwType = fileNameArray[2];
    fileHwVersion = fileNameArray[3];
    fileFwVersion = fileNameArray[4];
  } else {
    return DfuFileCheckResult.fileNameError;
  }

  if (deviceHwType !== HwTypeEnum.unknown) {
    const hwTypeString = FileNameHwEnum[deviceHwType];
    if (hwTypeString !== fileHwType) {
      return DfuFileCheckResult.deviceHwTypeMismatch;
    }

    if (deviceHwVersion === '') {
      return DfuFileCheckResult.deviceHwVersionUnknown;
    }
    const hwVersionString = `hv${deviceHwVersion}.0`;
    if (fileHwVersion.length < 7) {
      return DfuFileCheckResult.fileHwVersionFormatError;
    }
    if (fileHwVersion !== hwVersionString) {
      return DfuFileCheckResult.deviceHwVersionMismatch;
    }
  }

  if (deviceType !== FwTypeEnum.default) {
    const fwTypeString = FileNameFwEnum[deviceType];
    if (fileFwType !== 'default' && fwTypeString !== fileFwType) {
      return DfuFileCheckResult.deviceFwTypeMismatch;
    }

    if (deviceFwVersion === '') {
      return DfuFileCheckResult.deviceFwVersionUnknown;
    }
    const deviceFwVersionString = `${deviceFwVersion}.0`;
    const fileFwVersionString = fileFwVersion.slice(1).replace(`.${fileType}`, '');
    if (fileFwVersionString.length < 5) {
      return DfuFileCheckResult.fileFwVersionFormatError;
    }
    const result = versionCompare(fileFwVersionString, deviceFwVersionString);
    if (result === -1) {
      return DfuFileCheckResult.deviceFwVersionMismatch;
    }

    const fileFwVersionSix = versionCompare(fileFwVersionString, '6.0');
    const deviceFwVersionFive = versionCompare(deviceFwVersionString, '5.0');
    if (fileFwVersionSix !== -1 && deviceFwVersionFive === -1) {
      return DfuFileCheckResult.deviceCannotUpgradeToSix;
    }
  }
  return DfuFileCheckResult.ok;
}

function updateCheckStatus(result) {
  if (!elements) return;
  dfuState.checkResult = result;
  const message = dfuCheckMessages[result] || 'DFU file check failed.';
  elements.checkStatus.textContent = message;
  elements.checkStatus.classList.remove('success', 'error');
  if (result === DfuFileCheckResult.ok) {
    elements.checkStatus.classList.add('success');
  } else if (result !== DfuFileCheckResult.emptyFileName) {
    elements.checkStatus.classList.add('error');
  }
  elements.continueButton.disabled = result !== DfuFileCheckResult.ok;
  if (result !== DfuFileCheckResult.ok) {
    hideUploadSection();
  }
}

function updateUploadButtons() {
  if (!elements) return;
  const canUpload = dfuState.connected && dfuState.uploadReady && Boolean(dfuState.fileData);
  elements.uploadButton.disabled = !canUpload;
  elements.cancelButton.disabled = !dfuState.connected;
}

function resetUploadProgress() {
  if (!elements) return;
  elements.progressBar.style.width = '0%';
  elements.progressText.textContent = 'Upload progress: 0%';
}

function hideUploadSection() {
  if (!elements) return;
  elements.uploadSection.classList.add('hidden');
  dfuState.uploadReady = false;
  updateUploadButtons();
}

function showUploadSection() {
  if (!elements) return;
  elements.uploadSection.classList.remove('hidden');
  dfuState.uploadReady = true;
  updateUploadButtons();
}

function updateConnectionStatus(message, state = '') {
  if (!elements) return;
  elements.connectionStatus.textContent = message;
  elements.connectionStatus.classList.remove('success', 'error');
  if (state) {
    elements.connectionStatus.classList.add(state);
  }
}

function resolveDeviceType(value, mapping, fallbackLabel) {
  if (Number.isFinite(value) && mapping[value]) {
    return mapping[value];
  }
  return fallbackLabel;
}

function decodeHwTypeLabel(hwType) {
  const labels = {
    0: 'default',
    1: 'rhinoedge',
    2: 'elephantedge',
    3: 'wisentedge',
    4: 'cattracker',
    5: 'rangeredge',
    6: 'rhinopuck',
  };
  return resolveDeviceType(hwType, labels, 'unknown');
}

function decodeFwTypeLabel(fwType) {
  return resolveDeviceType(fwType, FileNameFwEnum, 'unknown');
}

function hydrateDeviceInfo() {
  const info = readDeviceInfo();
  if (!info) {
    dfuState.deviceInfo = null;
    renderDeviceInfo(null);
    updateCheckStatus(DfuFileCheckResult.emptyFileName);
    return;
  }

  dfuState.deviceInfo = {
    ...info,
    hwTypeLabel: decodeHwTypeLabel(info.hwType),
    fwTypeLabel: decodeFwTypeLabel(info.fwType),
  };
  renderDeviceInfo(dfuState.deviceInfo);
}

async function handleFileSelection(event) {
  if (!elements) return;
  const file = event.target.files[0];
  if (!file) {
    dfuState.file = null;
    dfuState.fileData = null;
    elements.fileStatus.textContent = 'No file selected.';
    updateCheckStatus(DfuFileCheckResult.emptyFileName);
    updateUploadStatus('file', 'pending', '');
    return;
  }

  dfuState.file = file;
  elements.fileStatus.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  if (!dfuState.deviceInfo) {
    updateCheckStatus(DfuFileCheckResult.deviceHwVersionUnknown);
    elements.deviceWarning.classList.remove('hidden');
    updateUploadStatus('file', 'error', 'Missing device info');
    return;
  }

  try {
    dfuState.fileData = await file.arrayBuffer();
  } catch (error) {
    dfuState.fileData = null;
  }

  const deviceFwType = Number.isFinite(dfuState.deviceInfo.fwType) ? dfuState.deviceInfo.fwType : FwTypeEnum.default;
  const deviceHwType = Number.isFinite(dfuState.deviceInfo.hwType) ? dfuState.deviceInfo.hwType : HwTypeEnum.unknown;

  const result = checkDfuFileName(
    file.name,
    deviceFwType,
    dfuState.deviceInfo.fwVersion || '',
    deviceHwType,
    dfuState.deviceInfo.hwVersion || ''
  );

  updateCheckStatus(result);
  if (result === DfuFileCheckResult.ok) {
    updateUploadStatus('file', 'completed', file.name);
  } else {
    updateUploadStatus('file', 'error', dfuCheckMessages[result] || 'Invalid file');
  }
}

function setupMcuManager() {
  if (!elements) return;
  dfuState.mcumgr = new MCUManager({
    mtu: 240,
    chunkTimeout: 5000,
    logger: {
      info: (message) => logDfu(message),
      error: (message) => logDfu(message, true),
    },
  });

  dfuState.mcumgr.onConnecting(() => {
    updateConnectionStatus('Connecting to device...');
  });

  dfuState.mcumgr.onConnect(() => {
    dfuState.connected = true;
    updateConnectionStatus(`Connected to ${dfuState.mcumgr.name || 'device'}`, 'success');
    if (elements.disconnectButton) {
      elements.disconnectButton.disabled = false;
    }
    resetUploadStatus(true);
    updateUploadButtons();
  });

  dfuState.mcumgr.onDisconnect((error) => {
    dfuState.connected = false;
    const message = error ? `Disconnected: ${error.message || error}` : 'Disconnected';
    updateConnectionStatus(message, error ? 'error' : '');
    if (elements.disconnectButton) {
      elements.disconnectButton.disabled = true;
    }
    resetUploadStatus(true);
    updateUploadButtons();
  });

  dfuState.mcumgr.onImageUploadProgress(({ percentage }) => {
    const safePercentage = Number.isFinite(percentage) ? percentage : 0;
    elements.progressBar.style.width = `${safePercentage}%`;
    elements.progressText.textContent = `Upload progress: ${safePercentage}%`;
    updateUploadStatus('start', 'active', `${safePercentage}%`);
  });

  dfuState.mcumgr.onImageUploadFinished(() => {
    logDfu('Upload finished.');
    showToast('DFU upload finished.');
    updateUploadStatus('finish', 'completed', 'Done');
    updateUploadStatus('state', 'active', 'Checking');
    if (dfuState.mcumgr && dfuState.mcumgr.cmdImageState) {
      dfuState.mcumgr.cmdImageState().catch(error => {
        logDfu(error.message || String(error), true);
        updateUploadStatus('state', 'error', 'Check failed');
      });
    } else {
      updateUploadStatus('state', 'completed', 'Done');
    }
    updateUploadButtons();
  });

  dfuState.mcumgr.onImageUploadError(({ error }) => {
    logDfu(error || 'Upload failed.', true);
    showToast(error || 'DFU upload failed.');
    updateUploadStatus('start', 'error', 'Failed');
    updateUploadStatus('finish', 'error', 'Failed');
    updateUploadButtons();
  });

  dfuState.mcumgr.onImageUploadCancelled(() => {
    logDfu('Upload cancelled.');
    showToast('DFU upload cancelled.');
    resetUploadProgress();
    updateUploadStatus('start', 'error', 'Cancelled');
    updateUploadButtons();
  });

  dfuState.mcumgr.onImageUploadChunkAck(({ off }) => {
    if (off !== undefined) {
      updateUploadStatus('ack', 'completed', `${off.toLocaleString()} bytes`);
    }
  });

  dfuState.mcumgr.onMessage(({ op, group, id, data }) => {
    logDfu(`MCU message op=${op} group=${group} id=${id}`);
    if (group === MGMT_GROUP_ID_IMAGE && id === IMG_MGMT_ID_STATE) {
      if (!dfuState.imageStateSilent) {
        if (data && data.images) {
          updateUploadStatus('state', 'completed', 'Done');
        } else {
          updateUploadStatus('state', 'error', 'No data');
        }
      }
      if (dfuState.pendingImageState && dfuState.pendingImageState.resolve) {
        dfuState.pendingImageState.resolve(data);
      }
    }
  });
}

function normalizeHash(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return value.toLowerCase().replace(/^0x/, '');
  }
  if (Array.isArray(value)) {
    return value.map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  if (value.buffer) {
    const bytes = new Uint8Array(value.buffer);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function pickActiveImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return images.find(image => image.active) || images.find(image => image.slot === 0) || images[0];
}

async function fetchImageState(timeoutMs = 5000) {
  if (!dfuState.mcumgr || !dfuState.connected) {
    throw new Error('DFU device not connected');
  }
  if (dfuState.pendingImageState) {
    dfuState.pendingImageState = null;
  }
  dfuState.imageStateSilent = true;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      dfuState.pendingImageState = null;
      dfuState.imageStateSilent = false;
      reject(new Error('Image state request timed out'));
    }, timeoutMs);

    dfuState.pendingImageState = {
      resolve: (data) => {
        clearTimeout(timeoutId);
        dfuState.pendingImageState = null;
        dfuState.imageStateSilent = false;
        resolve(data);
      },
    };

    dfuState.mcumgr.cmdImageState().catch(error => {
      clearTimeout(timeoutId);
      dfuState.pendingImageState = null;
      dfuState.imageStateSilent = false;
      reject(error);
    });
  });
}

async function checkFirmwareAlreadyInstalled() {
  if (!dfuState.mcumgr || !dfuState.connected || !dfuState.fileData) {
    return false;
  }
  let info = null;
  try {
    info = await dfuState.mcumgr.imageInfo(dfuState.fileData);
  } catch (error) {
    logDfu(`Unable to read image info: ${error.message || error}`, true);
    return false;
  }

  let state = null;
  try {
    state = await fetchImageState();
  } catch (error) {
    logDfu(`Unable to read device image state: ${error.message || error}`, true);
    return false;
  }

  const active = pickActiveImage(state && state.images ? state.images : []);
  if (!active) return false;

  const fileHash = normalizeHash(info.hash);
  const deviceHash = normalizeHash(active.hash);
  if (fileHash && deviceHash && fileHash === deviceHash) {
    return true;
  }

  if (active.version && info.version && active.version === info.version) {
    return true;
  }

  return false;
}

async function connectForDfu(allowPrompt = true) {
  if (!dfuState.mcumgr) {
    setupMcuManager();
  }

  logDfu('Connecting for DFU...');
  if (dfuState.useExistingConnection && dfuState.existingDevice) {
    try {
      if (dfuState.existingDevice.gatt && dfuState.existingDevice.gatt.connected) {
        await dfuState.mcumgr.connectDevice(dfuState.existingDevice, { reuseConnection: true });
        return;
      }
      if (!allowPrompt) {
        updateConnectionStatus('Reconnect to the device before starting DFU.', 'error');
        return;
      }
      await dfuState.mcumgr.connectDevice(dfuState.existingDevice);
      return;
    } catch (error) {
      updateConnectionStatus(`Connection failed: ${error.message || error}`, 'error');
      return;
    }
  }

  const filters = [];
  if (dfuState.deviceInfo && dfuState.deviceInfo.deviceName) {
    filters.push({ namePrefix: dfuState.deviceInfo.deviceName });
  }

  try {
    if (navigator.bluetooth && navigator.bluetooth.getDevices && dfuState.deviceInfo?.deviceName) {
      const devices = await navigator.bluetooth.getDevices();
      const matching = devices.find(device => device.name === dfuState.deviceInfo.deviceName);
      if (matching) {
        await dfuState.mcumgr.connectDevice(matching);
        setConnectButtonVisible(false);
        return;
      }
    }
    if (!allowPrompt) {
      updateConnectionStatus('DFU device not found. Use Scan to reconnect if needed.', 'error');
      return;
    }
    await dfuState.mcumgr.connect(filters.length ? filters : null);
  } catch (error) {
    updateConnectionStatus(`Connection failed: ${error.message || error}`, 'error');
  }
}

function connectIfAvailable() {
  if (dfuState.connected) return;
  connectForDfu(false);
}

function disconnectFromDfu() {
  if (!dfuState.mcumgr || !dfuState.connected) {
    return;
  }
  dfuState.mcumgr.disconnect();
}

function continueToUpload() {
  if (!elements) return;
  if (dfuState.checkResult !== DfuFileCheckResult.ok) {
    showToast('DFU file check must pass before continuing.');
    return;
  }
  showUploadSection();
  resetUploadStatus(true);
  updateUploadStatus('start', 'pending', '');
  updateUploadStatus('ack', 'pending', '');
  updateUploadStatus('finish', 'pending', '');
  updateUploadStatus('state', 'pending', '');
  if (!dfuState.connected) {
    connectForDfu(false);
  }
}

async function startUpload() {
  if (!elements) return;
  if (!dfuState.mcumgr || !dfuState.connected) {
    showToast('Connect to the device before starting DFU.');
    return;
  }
  if (!dfuState.fileData) {
    showToast('Select a DFU file before starting.');
    return;
  }

  const alreadyInstalled = await checkFirmwareAlreadyInstalled();
  if (alreadyInstalled) {
    showToast('Selected firmware is already installed on this device.');
    updateUploadStatus('start', 'error', 'Already installed');
    logDfu('Upload blocked: firmware already installed.');
    return;
  }

  resetUploadProgress();
  updateUploadStatus('start', 'active', '0%');
  updateUploadStatus('ack', 'pending', '');
  updateUploadStatus('finish', 'pending', '');
  updateUploadStatus('state', 'pending', '');
  logDfu('Starting DFU upload...');
  try {
    await dfuState.mcumgr.cmdUpload(dfuState.fileData);
  } catch (error) {
    logDfu(error.message || String(error), true);
    showToast('Failed to start DFU upload.');
    updateUploadStatus('start', 'error', 'Failed');
  }
}

function cancelUpload() {
  if (!dfuState.mcumgr) {
    return;
  }
  dfuState.mcumgr.cancelUpload();
}

function attachHandlers() {
  if (!elements) return;
  if (elements.fileInput) {
    elements.fileInput.addEventListener('change', handleFileSelection);
  }
  if (elements.continueButton) {
    elements.continueButton.addEventListener('click', continueToUpload);
  }
  if (elements.disconnectButton) {
    elements.disconnectButton.addEventListener('click', disconnectFromDfu);
  }
  if (elements.uploadButton) {
    elements.uploadButton.addEventListener('click', startUpload);
  }
  if (elements.cancelButton) {
    elements.cancelButton.addEventListener('click', cancelUpload);
  }
}

function resetUi() {
  if (!elements) return;
  resetUploadProgress();
  resetUploadStatus();
  updateUploadButtons();
  updateCheckStatus(dfuState.checkResult);
}

function init(options = null) {
  if (!bindElements()) return;
  dfuState.existingDevice = options && options.device ? options.device : null;
  dfuState.useExistingConnection = options ? Boolean(options.useExistingConnection) : false;
  hydrateDeviceInfo();
  updateCheckStatus(DfuFileCheckResult.emptyFileName);
  setupMcuManager();
  attachHandlers();
  resetUi();
  if (dfuState.useExistingConnection && dfuState.existingDevice) {
    logDfu('DFU init: reusing existing BLE connection if available.');
    connectIfAvailable();
  }
}

window.DfuApp = {
  init,
  hydrateDeviceInfo,
  resetUi,
  connect: connectIfAvailable,
};
