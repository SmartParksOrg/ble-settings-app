'use strict';

const DfuFileCheckResult = {
  ok: 0,
  warnOlderFirmware: 4,
  emptyFileName: 1,
  unsupportedFileType: 2,
  fileNameError: 3,
  warnUnverifiedFile: 9,
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
  [DfuFileCheckResult.warnOlderFirmware]: 'Selected firmware is older than the current device firmware. You can continue, but downgrading may not be supported.',
  [DfuFileCheckResult.emptyFileName]: 'Select a DFU file before continuing.',
  [DfuFileCheckResult.unsupportedFileType]: 'Unsupported DFU file type. Use a .bin or .zip file.',
  [DfuFileCheckResult.fileNameError]: 'DFU file name format is not recognized.',
  [DfuFileCheckResult.warnUnverifiedFile]: 'Selected file has not been checked for capatability! By continuing to use this file, you confirm that you understand the risk of bricking the connected device.',
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
  fileImageInfo: null,
  checkResult: DfuFileCheckResult.emptyFileName,
  connected: false,
  connecting: false,
  uploadReady: false,
  mcumgr: null,
  existingDevice: null,
  useExistingConnection: false,
  pendingImageState: null,
  imageStateSilent: false,
  awaitingReboot: false,
  expectedImageHash: null,
  expectedImageHashBytes: null,
  expectedImageVersion: null,
  reconnectTimer: null,
  reconnectStart: null,
  reconnectAttempts: 0,
  reconnectDelayMs: 1500,
  autoActivateArmed: false,
  autoActivateInProgress: false,
  reconnectUnlockAt: 0,
  userConfirmed: false,
};

let elements = null;
let lastLoggedProgress = null;
let lastChunkAckLogAt = 0;
let lastChunkAckOffset = 0;

const DFU_PENDING_KEY = 'dfuPending';

function isAppUpdateFile(fileName) {
  return String(fileName || '').trim().toLowerCase() === 'app_update.bin';
}

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
    fileMatchStatus: document.getElementById('dfu-file-match'),
    confirmationPanel: document.getElementById('dfu-confirmation'),
    confirmCancelButton: document.getElementById('dfu-confirm-cancel'),
    confirmProceedButton: document.getElementById('dfu-confirm-proceed'),
    uploadSection: document.getElementById('dfu-upload-section'),
    uploadButton: document.getElementById('dfu-upload'),
    cancelButton: document.getElementById('dfu-cancel'),
    reconnectButton: document.getElementById('dfu-reconnect'),
    resetSessionButton: document.getElementById('dfu-reset-session'),
    finishButton: document.getElementById('dfu-finish'),
    refreshStateButton: document.getElementById('dfu-refresh-state'),
    testImageButton: document.getElementById('dfu-test-image'),
    confirmImageButton: document.getElementById('dfu-confirm-image'),
    imageStateList: document.getElementById('dfu-image-state-list'),
    waitingOverlay: document.getElementById('dfu-waiting-overlay'),
    waitingScanButton: document.getElementById('dfu-waiting-scan'),
    waitingCountdown: document.getElementById('dfu-waiting-countdown'),
    waitingText: document.getElementById('dfu-waiting-text'),
    waitingSpinner: document.getElementById('dfu-waiting-spinner'),
    waitingContinueButton: document.getElementById('dfu-waiting-continue'),
    uploadMtu: document.getElementById('dfu-upload-mtu'),
    uploadTimeout: document.getElementById('dfu-upload-timeout'),
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
  item.classList.remove('active', 'completed', 'error', 'warning', 'danger');
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
    item.classList.remove('active', 'completed', 'error', 'warning', 'danger');
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

function readPendingDfu() {
  const stored = sessionStorage.getItem(DFU_PENDING_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch (error) {
    return null;
  }
}

function savePendingDfu(info) {
  try {
    sessionStorage.setItem(DFU_PENDING_KEY, JSON.stringify(info));
  } catch (error) {
    logDfu('Failed to store pending DFU info.', true);
  }
}

function clearPendingDfu() {
  dfuState.awaitingReboot = false;
  dfuState.expectedImageHash = null;
  dfuState.expectedImageHashBytes = null;
  dfuState.expectedImageVersion = null;
  dfuState.autoActivateArmed = false;
  dfuState.autoActivateInProgress = false;
  if (dfuState.reconnectTimer) {
    clearTimeout(dfuState.reconnectTimer);
    dfuState.reconnectTimer = null;
  }
  dfuState.reconnectAttempts = 0;
  dfuState.reconnectDelayMs = 1500;
  try {
    sessionStorage.removeItem(DFU_PENDING_KEY);
  } catch (error) {
    logDfu('Failed to clear pending DFU info.', true);
  }
}

function setDfuStepGroup(state = 'pending', detail = '') {
  updateUploadStatus('state', state, detail);
  updateUploadStatus('test', state, detail);
  updateUploadStatus('reboot', state, detail);
  updateUploadStatus('reconnect', state, detail);
  updateUploadStatus('verify', state, detail);
  updateUploadStatus('confirm', state, detail);
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
  if (isAppUpdateFile(fileName)) {
    return DfuFileCheckResult.warnUnverifiedFile;
  }
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
      return DfuFileCheckResult.warnOlderFirmware;
    }

    const fileFwVersionSix = versionCompare(fileFwVersionString, '6.0');
    const deviceFwVersionFive = versionCompare(deviceFwVersionString, '5.0');
    if (fileFwVersionSix !== -1 && deviceFwVersionFive === -1) {
      return DfuFileCheckResult.deviceCannotUpgradeToSix;
    }
  }
  return DfuFileCheckResult.ok;
}

function getCheckStatusType(result) {
  switch (result) {
    case DfuFileCheckResult.ok:
      return 'success';
    case DfuFileCheckResult.warnOlderFirmware:
      return 'warning';
    case DfuFileCheckResult.warnUnverifiedFile:
      return 'danger';
    case DfuFileCheckResult.emptyFileName:
      return '';
    default:
      return 'error';
  }
}

function isCheckAllowed(result) {
  return result === DfuFileCheckResult.ok
    || result === DfuFileCheckResult.warnOlderFirmware
    || result === DfuFileCheckResult.warnUnverifiedFile;
}

function updateCheckStatus(result) {
  if (!elements) return;
  dfuState.checkResult = result;
  const message = dfuCheckMessages[result] || 'DFU file check failed.';
  elements.checkStatus.textContent = message;
  elements.checkStatus.classList.remove('success', 'warning', 'danger', 'error');
  const statusType = getCheckStatusType(result);
  if (statusType) {
    elements.checkStatus.classList.add(statusType);
  }
  if (isCheckAllowed(result)) {
    if (dfuState.userConfirmed) {
      showUploadSection();
    } else {
      hideUploadSection();
    }
  } else {
    hideUploadSection();
  }
}

function showConfirmationPanel(show) {
  if (!elements || !elements.confirmationPanel) return;
  elements.confirmationPanel.classList.toggle('hidden', !show);
}

function resetConfirmationState() {
  dfuState.userConfirmed = false;
  showConfirmationPanel(false);
}

function updateFileMatchStatus(message = '', status = '') {
  if (!elements || !elements.fileMatchStatus) return;
  if (!message) {
    elements.fileMatchStatus.textContent = '';
    elements.fileMatchStatus.classList.add('hidden');
    elements.fileMatchStatus.classList.remove('success', 'warning', 'error');
    return;
  }
  elements.fileMatchStatus.textContent = message;
  elements.fileMatchStatus.classList.remove('hidden', 'success', 'warning', 'error');
  if (status) {
    elements.fileMatchStatus.classList.add(status);
  }
}

function updateUploadButtons() {
  if (!elements) return;
  const canUpload = dfuState.connected && dfuState.uploadReady && Boolean(dfuState.fileData) && dfuState.userConfirmed;
  elements.uploadButton.disabled = !canUpload;
  elements.cancelButton.disabled = !dfuState.connected;
  if (elements.reconnectButton) {
    const now = Date.now();
    const locked = dfuState.reconnectUnlockAt && now < dfuState.reconnectUnlockAt;
    elements.reconnectButton.disabled = dfuState.connected || dfuState.connecting || locked;
  }
  if (elements.waitingScanButton) {
    const now = Date.now();
    const locked = dfuState.reconnectUnlockAt && now < dfuState.reconnectUnlockAt;
    elements.waitingScanButton.disabled = dfuState.connected || dfuState.connecting || locked;
  }
  if (elements.refreshStateButton) {
    elements.refreshStateButton.disabled = !dfuState.connected;
  }
  if (elements.testImageButton) {
    elements.testImageButton.disabled = !dfuState.connected;
  }
  if (elements.confirmImageButton) {
    elements.confirmImageButton.disabled = !dfuState.connected;
  }
}

function setWaitingOverlay(visible) {
  if (!elements || !elements.waitingOverlay) return;
  elements.waitingOverlay.classList.toggle('hidden', !visible);
  if (visible) {
    const logFooter = document.getElementById('logFooter');
    if (logFooter && !logFooter.classList.contains('open') && typeof window.toggleLog === 'function') {
      window.toggleLog();
    }
  }
  if (!visible) {
    stopReconnectCountdown();
  }
}

function setWaitingOverlayState({
  message,
  showSpinner = true,
  showCountdown = false,
  showReconnect = false,
  showContinue = false,
} = {}) {
  if (!elements) return;
  if (elements.waitingText && typeof message === 'string') {
    elements.waitingText.textContent = message;
  }
  if (elements.waitingSpinner) {
    elements.waitingSpinner.classList.toggle('hidden', !showSpinner);
  }
  if (elements.waitingCountdown) {
    elements.waitingCountdown.classList.toggle('hidden', !showCountdown);
    if (!showCountdown) {
      stopReconnectCountdown();
    }
  }
  if (elements.waitingScanButton) {
    elements.waitingScanButton.classList.toggle('hidden', !showReconnect);
  }
  if (elements.waitingContinueButton) {
    elements.waitingContinueButton.classList.toggle('hidden', !showContinue);
  }
}

function setReconnectLock(ms = 40000) {
  dfuState.reconnectUnlockAt = Date.now() + ms;
  updateUploadButtons();
  setWaitingOverlayState({
    message: 'Device is rebooting. Reconnect will be enabled shortly.',
    showSpinner: true,
    showCountdown: true,
    showReconnect: true,
    showContinue: false,
  });
  startReconnectCountdown();
  if (dfuState.reconnectTimer) {
    clearTimeout(dfuState.reconnectTimer);
  }
  dfuState.reconnectTimer = setTimeout(() => {
    updateUploadButtons();
  }, ms + 100);
}

function ensureReconnectLock(ms = 40000) {
  const now = Date.now();
  if (dfuState.reconnectUnlockAt && now < dfuState.reconnectUnlockAt) {
    updateUploadButtons();
    return;
  }
  setReconnectLock(ms);
}

function startReconnectCountdown() {
  if (!elements || !elements.waitingCountdown) return;
  stopReconnectCountdown();
  const update = () => {
    const remainingMs = Math.max(0, dfuState.reconnectUnlockAt - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    if (remainingSec > 0) {
      elements.waitingCountdown.textContent = `Reconnect available in ${remainingSec}s…`;
      elements.waitingCountdown.classList.remove('hidden');
    } else {
      elements.waitingCountdown.textContent = 'Reconnect is now available.';
      elements.waitingCountdown.classList.remove('hidden');
      stopReconnectCountdown({ clearText: false });
    }
  };
  update();
  dfuState.reconnectCountdownTimer = setInterval(update, 1000);
}

function stopReconnectCountdown(options = {}) {
  if (!elements || !elements.waitingCountdown) return;
  if (dfuState.reconnectCountdownTimer) {
    clearInterval(dfuState.reconnectCountdownTimer);
    dfuState.reconnectCountdownTimer = null;
  }
  if (options.clearText !== false) {
    elements.waitingCountdown.textContent = '';
    elements.waitingCountdown.classList.add('hidden');
  }
}

async function waitForMainConnection(timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const connected = Boolean(window.device && window.device.gatt && window.device.gatt.connected && window.rxCharacteristic);
    if (connected) return true;
    await delay(200);
  }
  return Boolean(window.device && window.device.gatt && window.device.gatt.connected && window.rxCharacteristic);
}

async function getMainBleDevice() {
  if (window.device) {
    return window.device;
  }
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) {
    return null;
  }
  const desiredName = dfuState.deviceInfo?.deviceName || dfuState.mcumgr?.name || null;
  const devices = await navigator.bluetooth.getDevices();
  if (!devices.length) return null;
  if (desiredName) {
    return devices.find(known => known.name === desiredName) || devices[0];
  }
  return devices[0];
}

function setMainBleRefs(selectedDevice, server, rxChar, txChar) {
  if (selectedDevice) {
    window.device = selectedDevice;
  }
  if (server) {
    window.server = server;
  }
  if (rxChar) {
    window.rxCharacteristic = rxChar;
  }
  if (txChar) {
    window.txCharacteristic = txChar;
  }
}

async function returnToMainDeviceScreen() {
  setWaitingOverlayState({
    message: 'Connecting to device...',
    showSpinner: true,
    showCountdown: false,
    showReconnect: false,
    showContinue: false,
  });
  try {
    if (typeof window.connectToDevice !== 'function') {
      throw new Error('Main connection handler unavailable.');
    }
    if (window.device && window.device.gatt && window.device.gatt.connected && window.rxCharacteristic) {
      setWaitingOverlay(false);
      if (typeof window.toggleDfuView === 'function') {
        window.toggleDfuView(false);
      }
      return;
    }
    if (dfuState.mcumgr && dfuState.connected) {
      try {
        dfuState.mcumgr.disconnect();
      } catch (error) {
        logDfu(`DFU disconnect before main connect failed: ${error.message || error}`, true);
      }
      await delay(400);
    }
    const target = await getMainBleDevice();
    if (!target) {
      throw new Error('No known device to reconnect.');
    }
    await window.connectToDevice(target, { reuseConnected: true });
    setMainBleRefs(target, window.server, window.rxCharacteristic, window.txCharacteristic);
    if (typeof window.requestStatusMessage === 'function') {
      await window.requestStatusMessage();
    }
    logDfu(`Main BLE state after connect: device=${Boolean(window.device)} gatt=${Boolean(window.device && window.device.gatt)} connected=${Boolean(window.device && window.device.gatt && window.device.gatt.connected)} rx=${Boolean(window.rxCharacteristic)}`);
    const mainConnected = await waitForMainConnection(8000);
    if (!mainConnected) {
      throw new Error('Main connection not ready yet.');
    }
    setWaitingOverlay(false);
    if (typeof window.toggleDfuView === 'function') {
      window.toggleDfuView(false);
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    logDfu(`Return to device failed: ${message}`, true);
    showToast(`Reconnect failed: ${message}`);
    setWaitingOverlayState({
      message: `Unable to connect to the device. ${message}`,
      showSpinner: false,
      showCountdown: false,
      showReconnect: false,
      showContinue: true,
    });
  }
}

function setUploadProgress(percentage) {
  if (!elements) return;
  const safePercentage = Number.isFinite(percentage) ? percentage : 0;
  elements.progressBar.style.width = `${safePercentage}%`;
  elements.progressText.textContent = `Upload progress: ${safePercentage}%`;
}

function applyUploadSettings() {
  if (!dfuState.mcumgr || !elements) return;
  const mtuValue = Number.parseInt(elements.uploadMtu?.value, 10);
  const timeoutValue = Number.parseInt(elements.uploadTimeout?.value, 10);
  if (Number.isFinite(mtuValue) && mtuValue > 0) {
    dfuState.mcumgr.setMtu(mtuValue);
  }
  if (Number.isFinite(timeoutValue) && timeoutValue > 0) {
    dfuState.mcumgr.setChunkTimeout(timeoutValue);
  }
}

async function attemptStatusRefresh() {
  const globalDevice = window.device;
  const globalRx = window.rxCharacteristic;
  if (typeof window.requestStatusMessage !== 'function') {
    logDfu('Status refresh skipped: requestStatusMessage not available.');
    return;
  }
  if (!globalDevice || !globalDevice.gatt || !globalDevice.gatt.connected || !globalRx) {
    logDfu('Status refresh skipped: BLE status connection not available.');
    return;
  }
  try {
    await window.requestStatusMessage();
    setTimeout(() => {
      hydrateDeviceInfo();
    }, 600);
  } catch (error) {
    logDfu(`Status refresh failed: ${error.message || error}`, true);
  }
}

function resetUploadProgress() {
  if (!elements) return;
  elements.progressBar.style.width = '0%';
  elements.progressText.textContent = 'Upload progress: 0%';
}

function resetDfuSession() {
  if (!elements) return;
  try {
    sessionStorage.removeItem('dfuDeviceInfo');
  } catch (error) {
    logDfu('Failed to clear DFU device info.', true);
  }
  if (elements.fileInput) {
    elements.fileInput.value = '';
  }
  dfuState.file = null;
  dfuState.fileData = null;
  dfuState.fileImageInfo = null;
  dfuState.checkResult = DfuFileCheckResult.emptyFileName;
  resetConfirmationState();
  clearPendingDfu();
  resetUploadProgress();
  resetUploadStatus();
  updateCheckStatus(DfuFileCheckResult.emptyFileName);
  updateFileMatchStatus();
  updateUploadButtons();
  renderDeviceInfo(dfuState.deviceInfo);
  showToast('DFU session reset. Reconnect and reselect a file.');
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

function hydratePendingDfu() {
  const pending = readPendingDfu();
  if (!pending || !pending.expectedHash) {
    return;
  }
  if (!dfuState.deviceInfo || !dfuState.deviceInfo.deviceName) {
    return;
  }
  if (pending.deviceName !== dfuState.deviceInfo.deviceName) {
    return;
  }
  dfuState.awaitingReboot = true;
  dfuState.expectedImageHash = pending.expectedHash;
  dfuState.expectedImageHashBytes = hashToBytes(pending.expectedHash);
  dfuState.expectedImageVersion = pending.expectedVersion || null;
  dfuState.reconnectStart = pending.startedAt || Date.now();
  showUploadSection();
  resetUploadStatus(true);
  updateUploadStatus('file', 'warning', 'Previous DFU');
  updateUploadStatus('start', 'completed', 'Done');
  updateUploadStatus('finish', 'completed', 'Done');
  updateUploadStatus('state', 'active', 'Waiting for reboot');
  updateUploadStatus('reboot', 'active', 'Waiting');
  updateUploadStatus('reconnect', 'active', 'Waiting');
  updateUploadButtons();
  if (dfuState.connected) {
    verifyRebootedFirmware().catch(error => {
      logDfu(error.message || String(error), true);
      updateUploadStatus('state', 'error', 'Verification failed');
    });
  } else {
    scheduleReconnectAttempt();
  }
}

async function handleFileSelection(event) {
  if (!elements) return;
  const file = event.target.files[0];
  if (!file) {
    dfuState.file = null;
    dfuState.fileData = null;
    dfuState.fileImageInfo = null;
    clearPendingDfu();
    elements.fileStatus.textContent = 'No file selected.';
    updateCheckStatus(DfuFileCheckResult.emptyFileName);
    updateFileMatchStatus();
    resetConfirmationState();
    resetUploadProgress();
    resetUploadStatus();
    updateUploadStatus('file', 'pending', '');
    return;
  }

  dfuState.file = file;
  elements.fileStatus.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  const isAppUpdate = isAppUpdateFile(file.name);
  if (!dfuState.deviceInfo && !isAppUpdate) {
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
  dfuState.fileImageInfo = null;
  if (dfuState.fileData && dfuState.mcumgr) {
    try {
      dfuState.fileImageInfo = await dfuState.mcumgr.imageInfo(dfuState.fileData);
    } catch (error) {
      dfuState.fileImageInfo = null;
    }
  }

  const deviceFwType = dfuState.deviceInfo && Number.isFinite(dfuState.deviceInfo.fwType) ? dfuState.deviceInfo.fwType : FwTypeEnum.default;
  const deviceHwType = dfuState.deviceInfo && Number.isFinite(dfuState.deviceInfo.hwType) ? dfuState.deviceInfo.hwType : HwTypeEnum.unknown;

  const result = checkDfuFileName(
    file.name,
    deviceFwType,
    dfuState.deviceInfo ? (dfuState.deviceInfo.fwVersion || '') : '',
    deviceHwType,
    dfuState.deviceInfo ? (dfuState.deviceInfo.hwVersion || '') : ''
  );

  updateCheckStatus(result);
  if (result === DfuFileCheckResult.ok) {
    updateUploadStatus('file', 'completed', file.name);
  } else if (result === DfuFileCheckResult.warnOlderFirmware) {
    updateUploadStatus('file', 'warning', file.name);
  } else if (result === DfuFileCheckResult.warnUnverifiedFile) {
    updateUploadStatus('file', 'danger', file.name);
  } else {
    updateUploadStatus('file', 'error', dfuCheckMessages[result] || 'Invalid file');
  }
  updateFileMatchStatus();

  if (isCheckAllowed(result)) {
    showConfirmationPanel(true);
    resetUploadProgress();
    resetUploadStatus(true);
    updateUploadStatus('start', 'pending', '');
    updateUploadStatus('ack', 'pending', '');
    updateUploadStatus('finish', 'pending', '');
    setDfuStepGroup('pending', '');
    if (dfuState.connected) {
      refreshImageState();
    }
  } else {
    resetUploadProgress();
  }
}

function setupMcuManager() {
  if (!elements) return;
  dfuState.mcumgr = new MCUManager({
    mtu: 240,
    chunkTimeout: 5000,
    autoReconnect: false,
    logger: {
      info: (message) => logDfu(message),
      error: (message) => logDfu(message, true),
    },
  });

  dfuState.mcumgr.onConnecting(() => {
    updateConnectionStatus('Connecting to device...');
    dfuState.connecting = true;
    updateUploadButtons();
  });

  dfuState.mcumgr.onConnect(() => {
    dfuState.connected = true;
    dfuState.connecting = false;
    updateConnectionStatus(`Connected to ${dfuState.mcumgr.name || 'device'}`, 'success');
    if (elements.disconnectButton) {
      elements.disconnectButton.disabled = false;
    }
    resetUploadStatus(true);
    updateUploadButtons();
    if (dfuState.awaitingReboot) {
      setWaitingOverlay(true);
      setWaitingOverlayState({
        message: 'Reconnected. Verifying firmware...',
        showSpinner: true,
        showCountdown: false,
        showReconnect: false,
        showContinue: false,
      });
    } else {
      setWaitingOverlay(false);
    }
    if (!dfuState.awaitingReboot && dfuState.fileData && isCheckAllowed(dfuState.checkResult)) {
      refreshImageState();
    }
    if (dfuState.awaitingReboot) {
      updateUploadStatus('reboot', 'completed', 'Done');
      updateUploadStatus('reconnect', 'completed', 'Done');
      verifyRebootedFirmware().catch(error => {
        logDfu(error.message || String(error), true);
        updateUploadStatus('verify', 'error', 'Verification failed');
      });
    }
  });

  dfuState.mcumgr.onDisconnect((error) => {
    dfuState.connected = false;
    dfuState.connecting = false;
    const message = error ? `Disconnected: ${error.message || error}` : 'Disconnected';
    updateConnectionStatus(message, error ? 'error' : '');
    if (elements.disconnectButton) {
      elements.disconnectButton.disabled = true;
    }
    resetUploadStatus(true);
    updateUploadButtons();
    if (dfuState.awaitingReboot) {
      updateUploadStatus('reboot', 'active', 'Waiting');
      updateUploadStatus('reconnect', 'active', 'Waiting');
      updateConnectionStatus('Waiting for device to reboot...', '');
      setWaitingOverlay(true);
      ensureReconnectLock();
      dfuState.reconnectAttempts = 0;
      dfuState.reconnectDelayMs = 1500;
      scheduleReconnectAttempt();
    }
  });

  dfuState.mcumgr.onImageUploadProgress(({ percentage, timeoutAdjusted, newTimeout }) => {
    const safePercentage = Number.isFinite(percentage) ? percentage : 0;
    setUploadProgress(safePercentage);
    updateUploadStatus('start', 'active', `${safePercentage}%`);
    if (timeoutAdjusted && Number.isFinite(newTimeout)) {
      logDfu(`Timeout adjusted to ${newTimeout}ms at ${safePercentage}%`);
    }
    if (lastLoggedProgress === null || safePercentage - lastLoggedProgress >= 5 || safePercentage === 100) {
      logDfu(`Upload progress ${safePercentage}%`);
      lastLoggedProgress = safePercentage;
    }
  });

  dfuState.mcumgr.onImageUploadFinished(() => {
    logDfu('Upload finished.');
    showToast('DFU upload finished.');
    setUploadProgress(100);
    updateUploadStatus('finish', 'completed', 'Done');
    updateUploadStatus('state', 'active', 'Checking');
    if (dfuState.mcumgr) {
      handlePostUploadFlow().catch(error => {
        logDfu(error.message || String(error), true);
        updateUploadStatus('state', 'error', 'Check failed');
      });
    } else {
      updateUploadStatus('state', 'completed', 'Done');
    }
    updateUploadButtons();
  });

  dfuState.mcumgr.onImageUploadError(({ error, errorCode, consecutiveTimeouts, totalTimeouts }) => {
    const detail = [];
    if (Number.isFinite(errorCode)) detail.push(`code=${errorCode}`);
    if (Number.isFinite(consecutiveTimeouts)) detail.push(`consecutive=${consecutiveTimeouts}`);
    if (Number.isFinite(totalTimeouts)) detail.push(`total=${totalTimeouts}`);
    const suffix = detail.length ? ` (${detail.join(', ')})` : '';
    logDfu(`${error || 'Upload failed.'}${suffix}`, true);
    showToast(error || 'DFU upload failed.');
    updateUploadStatus('start', 'error', 'Failed');
    updateUploadStatus('finish', 'error', 'Failed');
    updateUploadButtons();
  });

  dfuState.mcumgr.onImageUploadCancelled(() => {
    logDfu('Upload cancelled.');
    showToast('DFU upload cancelled.');
    resetUploadProgress();
    updateUploadStatus('start', 'warning', 'Cancelled');
    updateUploadStatus('finish', 'warning', 'Cancelled');
    setDfuStepGroup('warning', 'Cancelled');
    clearPendingDfu();
    updateUploadButtons();
  });

  dfuState.mcumgr.onImageUploadChunkAck(({ off }) => {
    if (off !== undefined) {
      updateUploadStatus('ack', 'completed', `${off.toLocaleString()} bytes`);
      const now = Date.now();
      if (off - lastChunkAckOffset >= 65536 || now - lastChunkAckLogAt >= 1500) {
        logDfu(`Chunk ack offset=${off}`);
        lastChunkAckLogAt = now;
        lastChunkAckOffset = off;
      }
    }
  });

  dfuState.mcumgr.onMessage(({ op, group, id, data }) => {
    logDfu(`MCU message op=${op} group=${group} id=${id}`);
    if (group === MGMT_GROUP_ID_IMAGE && id === IMG_MGMT_ID_STATE) {
      if (!dfuState.imageStateSilent) {
        if (data && data.images) {
          updateUploadStatus('state', 'completed', 'Done');
          renderImageState(data);
          updateFileMatchFromState(data);
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
  if (value instanceof Uint8Array) {
    return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  if (Array.isArray(value)) {
    return value.map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  if (typeof value === 'object') {
    if (Number.isFinite(value.length)) {
      const bytes = [];
      for (let i = 0; i < value.length; i += 1) {
        const byte = value[i];
        bytes.push(Number.isFinite(byte) ? byte : 0);
      }
      return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    const keys = Object.keys(value).filter(key => String(Number.parseInt(key, 10)) === key);
    if (keys.length) {
      const sorted = keys.map(key => Number.parseInt(key, 10)).sort((a, b) => a - b);
      return sorted.map(index => {
        const byte = value[index];
        return (Number.isFinite(byte) ? byte : 0).toString(16).padStart(2, '0');
      }).join('');
    }
  }
  if (value.buffer) {
    const bytes = new Uint8Array(value.buffer);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function hexToBytes(hex) {
  const cleaned = String(hex || '').trim().replace(/^0x/, '').toLowerCase();
  if (!cleaned || cleaned.length % 2 !== 0) return null;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleaned.slice(i, i + 2), 16);
  }
  return bytes;
}

function base64ToBytes(base64) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (error) {
    return null;
  }
}

function hashToBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === 'object') {
    if (Number.isFinite(value.length)) {
      const bytes = [];
      for (let i = 0; i < value.length; i += 1) {
        const byte = value[i];
        bytes.push(Number.isFinite(byte) ? byte : 0);
      }
      return new Uint8Array(bytes);
    }
    const keys = Object.keys(value).filter(key => String(Number.parseInt(key, 10)) === key);
    if (keys.length) {
      const sorted = keys.map(key => Number.parseInt(key, 10)).sort((a, b) => a - b);
      const bytes = sorted.map(index => {
        const byte = value[index];
        return Number.isFinite(byte) ? byte : 0;
      });
      return new Uint8Array(bytes);
    }
  }
  if (typeof value === 'string') {
    const hex = hexToBytes(value);
    if (hex) return hex;
    return base64ToBytes(value);
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

function isRetryableImageStateError(error) {
  const message = String(error && error.message ? error.message : error);
  return message.includes('GATT operation already in progress')
    || message.includes('timed out')
    || message.includes('NetworkError');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchImageStateWithRetry(attempts = 3, delayMs = 600) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await delay(delayMs);
    }
    try {
      return await fetchImageState();
    } catch (error) {
      lastError = error;
      if (!isRetryableImageStateError(error)) {
        throw error;
      }
    }
  }
  throw lastError || new Error('Image state request failed');
}

function summarizeImageState(state) {
  if (!state || !state.images) return 'No image data.';
  return state.images.map(image => {
    const hash = normalizeHash(image.hash);
    const shortHash = hash ? `${hash.slice(0, 8)}...` : 'unknown';
    return `slot ${image.slot}: active=${Boolean(image.active)} pending=${Boolean(image.pending)} confirmed=${Boolean(image.confirmed)} bootable=${Boolean(image.bootable)} hash=${shortHash}`;
  }).join(' | ');
}

function renderImageState(state) {
  if (!elements || !elements.imageStateList) return;
  if (!state || !state.images || !state.images.length) {
    elements.imageStateList.innerHTML = '<div class="dfu-image-state-empty">No image state loaded.</div>';
    return;
  }
  const cards = state.images.map(image => {
    const hash = normalizeHash(image.hash);
    const shortHash = hash ? `${hash.slice(0, 8)}...` : 'unknown';
    const classes = ['dfu-image-slot'];
    if (image.active) classes.push('active');
    return `
      <div class="${classes.join(' ')}">
        <div class="dfu-image-slot-header">
          <span>Slot #${image.slot}</span>
          <span>${image.active ? 'Active' : 'Standby'}</span>
        </div>
        <div class="dfu-image-slot-grid">
          <div>Version: <span>${image.version || 'unknown'}</span></div>
          <div>Bootable: <span>${image.bootable ? 'Yes' : 'No'}</span></div>
          <div>Confirmed: <span>${image.confirmed ? 'Yes' : 'No'}</span></div>
          <div>Pending: <span>${image.pending ? 'Yes' : 'No'}</span></div>
          <div>Hash: <span>${shortHash}</span></div>
        </div>
      </div>
    `;
  }).join('');
  elements.imageStateList.innerHTML = cards;
}

function updateFileMatchFromState(state) {
  if (!state || !state.images || !dfuState.fileImageInfo) {
    updateFileMatchStatus();
    return;
  }
  const fileHash = normalizeHash(dfuState.fileImageInfo.hash);
  if (!fileHash) {
    updateFileMatchStatus();
    return;
  }
  const slot0 = state.images.find(image => image.slot === 0);
  const slot1 = state.images.find(image => image.slot === 1);
  const slot0Hash = slot0 ? normalizeHash(slot0.hash) : null;
  const slot1Hash = slot1 ? normalizeHash(slot1.hash) : null;
  if (slot0Hash && fileHash === slot0Hash) {
    if (slot0 && slot0.confirmed === false) {
      updateFileMatchStatus('Selected file matches Slot #0 (active, not confirmed). Confirming automatically...', 'warning');
      if (!dfuState.autoActivateInProgress) {
        dfuState.autoActivateInProgress = true;
        confirmActiveImage().finally(() => {
          dfuState.autoActivateInProgress = false;
        });
      }
    } else {
      updateFileMatchStatus('Selected file matches Slot #0 (active). No upload needed.', 'success');
    }
    return;
  }
  if (slot1Hash && fileHash === slot1Hash) {
    if (slot1 && slot1.pending) {
      updateFileMatchStatus('Selected file matches Slot #1 (pending). Waiting for reboot and confirm.', 'warning');
      return;
    }
    updateFileMatchStatus('Selected file matches Slot #1 (standby). Will activate without re-upload.', 'warning');
    if (dfuState.userConfirmed && dfuState.connected && isCheckAllowed(dfuState.checkResult) && !dfuState.awaitingReboot && !dfuState.autoActivateInProgress) {
      dfuState.autoActivateArmed = true;
      dfuState.autoActivateInProgress = true;
      testUploadedImage(state).finally(() => {
        dfuState.autoActivateInProgress = false;
      });
    }
    return;
  }
  updateFileMatchStatus('Selected file not found on the device.', 'error');
}

async function refreshImageState() {
  if (!dfuState.mcumgr || !dfuState.connected) {
    showToast('Connect to the device before checking image state.');
    return null;
  }
  try {
    const state = await fetchImageStateWithRetry();
    logDfu(`Image state: ${summarizeImageState(state)}`);
    renderImageState(state);
    updateFileMatchFromState(state);
    return state;
  } catch (error) {
    logDfu(`Image state failed: ${error.message || error}`, true);
    return null;
  }
}

async function testUploadedImage(stateOverride = null) {
  if (!dfuState.mcumgr || !dfuState.connected) {
    showToast('Connect to the device before testing an image.');
    return;
  }
  const state = stateOverride || await refreshImageState();
  if (!state || !state.images) {
    showToast('Unable to read image state.');
    return;
  }
  const slot1 = state.images.find(image => image.slot === 1);
  const fileHash = normalizeHash(dfuState.fileImageInfo && dfuState.fileImageInfo.hash);
  const slot1Hash = slot1 ? normalizeHash(slot1.hash) : null;
  const targetHash = (fileHash && slot1Hash && fileHash === slot1Hash)
    ? fileHash
    : (slot1Hash || fileHash);
  const targetBytes = hashToBytes(slot1 && slot1.hash) || hashToBytes(dfuState.fileImageInfo && dfuState.fileImageInfo.hash) || hashToBytes(targetHash);
  if (!targetHash || !targetBytes) {
    showToast('No image hash available to test.');
    return;
  }
  updateUploadStatus('test', 'active', 'Marking for test');
  try {
    await dfuState.mcumgr.cmdImageTest(targetBytes);
    updateUploadStatus('test', 'completed', 'Done');
    updateUploadStatus('reboot', 'active', 'Rebooting');
    dfuState.awaitingReboot = true;
    dfuState.reconnectStart = Date.now();
    logDfu('Reboot requested; waiting for reconnect.');
    setWaitingOverlay(true);
    setReconnectLock();
    savePendingDfu({
      deviceName: dfuState.deviceInfo ? dfuState.deviceInfo.deviceName : null,
      expectedHash: targetBytes,
      expectedVersion: dfuState.fileImageInfo ? dfuState.fileImageInfo.version : null,
      startedAt: dfuState.reconnectStart,
    });
    await dfuState.mcumgr.cmdReset();
  } catch (error) {
    updateUploadStatus('test', 'error', 'Failed');
    logDfu(`Test image failed: ${error.message || error}`, true);
  }
}

async function confirmActiveImage() {
  if (!dfuState.mcumgr || !dfuState.connected) {
    showToast('Connect to the device before confirming.');
    return;
  }
  const state = await refreshImageState();
  if (!state || !state.images) {
    showToast('Unable to read image state.');
    return;
  }
  const active = pickActiveImage(state.images);
  const hash = normalizeHash(active && active.hash);
  const hashBytes = hashToBytes(active && active.hash);
  if (!hash || !hashBytes) {
    showToast('No active image hash found.');
    return;
  }
  updateUploadStatus('confirm', 'active', 'Confirming');
  try {
    await dfuState.mcumgr.cmdImageConfirm(hashBytes);
    updateUploadStatus('confirm', 'completed', 'Confirmed');
  } catch (error) {
    updateUploadStatus('confirm', 'error', 'Failed');
    logDfu(`Confirm failed: ${error.message || error}`, true);
  }
}

function findImageByHash(images, hash) {
  if (!Array.isArray(images) || !hash) return null;
  return images.find(image => normalizeHash(image.hash) === hash) || null;
}

async function handlePostUploadFlow(existingState = null) {
  await delay(400);
  const response = existingState || await fetchImageStateWithRetry(3, 750);
  if (!response || !response.images) {
    updateUploadStatus('state', 'error', 'No data');
    return;
  }

  const expectedHash = normalizeHash(dfuState.fileImageInfo && dfuState.fileImageInfo.hash);
  const expectedHashBytes = hashToBytes(dfuState.fileImageInfo && dfuState.fileImageInfo.hash);
  dfuState.expectedImageHash = expectedHash;
  dfuState.expectedImageHashBytes = expectedHashBytes;
  dfuState.expectedImageVersion = dfuState.fileImageInfo && dfuState.fileImageInfo.version ? dfuState.fileImageInfo.version : null;

  if (!expectedHash) {
    updateUploadStatus('state', 'completed', 'Done (no hash)');
    return;
  }

  const uploadedImage = findImageByHash(response.images, expectedHash);
  if (!uploadedImage) {
    updateUploadStatus('state', 'warning', 'Uploaded image not found');
    return;
  }

  updateUploadStatus('state', 'completed', 'Found image');
  if (uploadedImage.active) {
    updateUploadStatus('verify', 'completed', 'Already active');
    updateUploadStatus('confirm', 'completed', 'Confirmed');
    return;
  }

  if (!dfuState.mcumgr || !dfuState.connected) {
    updateUploadStatus('state', 'error', 'Not connected');
    return;
  }

  try {
    if (!uploadedImage.pending) {
      updateUploadStatus('test', 'active', 'Marking for test');
      if (!expectedHashBytes) {
        throw new Error('No image hash bytes available for test');
      }
      await dfuState.mcumgr.cmdImageTest(expectedHashBytes);
      updateUploadStatus('test', 'completed', 'Done');
    } else {
      updateUploadStatus('test', 'completed', 'Already pending');
    }
    updateUploadStatus('reboot', 'active', 'Rebooting');
    dfuState.awaitingReboot = true;
    dfuState.reconnectStart = Date.now();
    logDfu('Reboot requested; waiting for reconnect.');
    savePendingDfu({
      deviceName: dfuState.deviceInfo ? dfuState.deviceInfo.deviceName : null,
      expectedHash: expectedHashBytes || expectedHash,
      expectedVersion: dfuState.expectedImageVersion,
      startedAt: dfuState.reconnectStart,
    });
    await dfuState.mcumgr.cmdReset();
  } catch (error) {
    updateUploadStatus('reboot', 'error', 'Reboot failed');
    throw error;
  }
}

function shouldKeepReconnecting() {
  if (!dfuState.awaitingReboot) return false;
  const start = dfuState.reconnectStart || Date.now();
  return Date.now() - start < 120000;
}

function scheduleReconnectAttempt() {
  updateUploadStatus('reconnect', 'active', 'Waiting');
  updateConnectionStatus('Waiting for device to reboot...', '');
  setWaitingOverlay(true);
}

async function verifyRebootedFirmware() {
  if (!dfuState.expectedImageHash) {
    clearPendingDfu();
    updateUploadStatus('reconnect', 'completed', 'Done');
    updateUploadStatus('verify', 'completed', 'Reconnected');
    setWaitingOverlayState({
      message: 'Reconnected. Ready to continue.',
      showSpinner: false,
      showCountdown: false,
      showReconnect: false,
      showContinue: true,
    });
    return;
  }
  updateUploadStatus('verify', 'active', 'Verifying');
  const response = await fetchImageStateWithRetry(4, 1000);
  if (!response || !response.images) {
    updateUploadStatus('verify', 'error', 'No data');
    return;
  }
  const image = findImageByHash(response.images, dfuState.expectedImageHash);
  if (image && image.active) {
    updateUploadStatus('verify', 'completed', 'Active');
    try {
      const hashBytes = dfuState.expectedImageHashBytes || hashToBytes(dfuState.expectedImageHash);
      if (!hashBytes) {
        throw new Error('No image hash bytes available for confirm');
      }
      if (!image.confirmed) {
        updateUploadStatus('confirm', 'active', 'Confirming');
      } else {
        updateUploadStatus('confirm', 'completed', 'Already confirmed');
      }
      await dfuState.mcumgr.cmdImageConfirm(hashBytes);
      updateUploadStatus('confirm', 'completed', 'Confirmed');
      attemptStatusRefresh();
      setWaitingOverlayState({
        message: 'Firmware verified. You can return to the device.',
        showSpinner: false,
        showCountdown: false,
        showReconnect: false,
        showContinue: true,
      });
      if (typeof window.toggleDfuView === 'function') {
        showToast('DFU complete. You can return to the main screen.');
      }
    } catch (error) {
      logDfu(`Confirm failed: ${error.message || error}`, true);
      setWaitingOverlayState({
        message: 'Reconnected, but firmware confirmation failed.',
        showSpinner: false,
        showCountdown: false,
        showReconnect: true,
        showContinue: false,
      });
    }
    clearPendingDfu();
    return;
  }
  updateUploadStatus('verify', 'warning', 'Not active yet');
  scheduleReconnectAttempt();
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
    state = await fetchImageStateWithRetry();
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

async function getFirmwarePresence() {
  if (!dfuState.mcumgr || !dfuState.connected || !dfuState.fileData) {
    return { status: 'unknown', image: null, state: null };
  }
  let info = null;
  try {
    info = dfuState.fileImageInfo || await dfuState.mcumgr.imageInfo(dfuState.fileData);
  } catch (error) {
    logDfu(`Unable to read image info: ${error.message || error}`, true);
    return { status: 'unknown', image: null, state: null };
  }

  let state = null;
  try {
    state = await fetchImageStateWithRetry();
  } catch (error) {
    logDfu(`Unable to read device image state: ${error.message || error}`, true);
    return { status: 'unknown', image: null, state: null };
  }

  const fileHash = normalizeHash(info.hash);
  if (!fileHash || !state || !state.images) {
    return { status: 'unknown', image: null, state };
  }

  const image = findImageByHash(state.images, fileHash);
  if (!image) {
    return { status: 'missing', image: null, state };
  }
  if (image.active) {
    return { status: 'active', image, state };
  }
  if (image.pending) {
    return { status: 'pending', image, state };
  }
  return { status: 'present', image, state };
}

async function connectForDfu(allowPrompt = true) {
  if (!dfuState.mcumgr) {
    setupMcuManager();
  }
  if (dfuState.connected || dfuState.connecting) {
    return;
  }
  dfuState.connecting = true;

  logDfu('Connecting for DFU...');
  if (dfuState.useExistingConnection && dfuState.existingDevice) {
    try {
      if (dfuState.existingDevice.gatt && dfuState.existingDevice.gatt.connected) {
        await dfuState.mcumgr.connectDevice(dfuState.existingDevice, { reuseConnection: true });
        return;
      }
      if (!allowPrompt) {
        if (dfuState.awaitingReboot) {
          updateConnectionStatus('Waiting for device to reboot...', '');
        } else {
          updateConnectionStatus('Reconnect to the device before starting DFU.', 'error');
        }
        dfuState.connecting = false;
        return;
      }
      await dfuState.mcumgr.connectDevice(dfuState.existingDevice);
      return;
    } catch (error) {
      updateConnectionStatus(`Connection failed: ${error.message || error}`, 'error');
      dfuState.connecting = false;
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
      if (dfuState.awaitingReboot) {
        updateConnectionStatus('Waiting for device to reboot...', '');
      } else {
        updateConnectionStatus('DFU device not found. Use Scan to reconnect if needed.', 'error');
      }
      dfuState.connecting = false;
      return;
    }
    if (dfuState.awaitingReboot && filters.length) {
      logDfu('Reboot reconnect: opening device picker without name filter.');
      await dfuState.mcumgr.connect(null);
    } else {
      await dfuState.mcumgr.connect(filters.length ? filters : null);
    }
  } catch (error) {
    updateConnectionStatus(`Connection failed: ${error.message || error}`, 'error');
    dfuState.connecting = false;
  }
}

async function silentReconnectIfAvailable() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices || !dfuState.deviceInfo?.deviceName) {
    return;
  }
  try {
    const devices = await navigator.bluetooth.getDevices();
    const matching = devices.find(device => device.name === dfuState.deviceInfo.deviceName);
    if (matching) {
      await dfuState.mcumgr.connectDevice(matching);
    }
  } catch (error) {
    logDfu(`Silent reconnect failed: ${error.message || error}`, true);
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
  clearPendingDfu();
  dfuState.mcumgr.disconnect();
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
  if (!isCheckAllowed(dfuState.checkResult)) {
    showToast('DFU file check must pass before starting.');
    return;
  }
  applyUploadSettings();

  const presence = await getFirmwarePresence();
  if (presence.status === 'active') {
    showToast('Selected firmware is already active on this device.');
    updateUploadStatus('start', 'completed', 'Already active');
    updateUploadStatus('finish', 'completed', 'Done');
    updateUploadStatus('state', 'completed', 'Checked');
    updateUploadStatus('test', 'completed', 'Not required');
    updateUploadStatus('reboot', 'completed', 'Not required');
    updateUploadStatus('reconnect', 'completed', 'Not required');
    updateUploadStatus('verify', 'completed', 'Active');
    updateUploadStatus('confirm', 'completed', 'Confirmed');
    clearPendingDfu();
    logDfu('Upload skipped: firmware already active.');
    return;
  }
  if (presence.status === 'present' || presence.status === 'pending') {
    showToast('Firmware already uploaded. Continuing DFU to reboot and verify.');
    updateUploadStatus('start', 'completed', 'Skipped');
    updateUploadStatus('finish', 'completed', 'Skipped');
    updateUploadStatus('state', 'active', 'Checking');
    await handlePostUploadFlow(presence.state);
    return;
  }

  resetUploadProgress();
  lastLoggedProgress = null;
  updateUploadStatus('start', 'active', '0%');
  updateUploadStatus('ack', 'pending', '');
  updateUploadStatus('finish', 'pending', '');
  setDfuStepGroup('pending', '');
  logDfu('Starting DFU upload...');
  const mtu = dfuState.mcumgr.getMtu ? dfuState.mcumgr.getMtu() : 'unknown';
  const timeout = dfuState.mcumgr.getChunkTimeout ? dfuState.mcumgr.getChunkTimeout() : 'unknown';
  const fallbacks = dfuState.mcumgr.getMtuFallbacks ? dfuState.mcumgr.getMtuFallbacks() : [];
  const sizeKb = (dfuState.fileData.byteLength / 1024).toFixed(1);
  const imageVersion = dfuState.fileImageInfo && dfuState.fileImageInfo.version ? dfuState.fileImageInfo.version : 'unknown';
  const imageHash = normalizeHash(dfuState.fileImageInfo && dfuState.fileImageInfo.hash);
  logDfu(`Upload config: size=${sizeKb}KB, mtu=${mtu}, timeout=${timeout}ms, fallbacks=${fallbacks.join(', ') || 'none'}`);
  logDfu(`Image info: version=${imageVersion}, hash=${imageHash || 'unknown'}`);
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
  clearPendingDfu();
  dfuState.mcumgr.cancelUpload();
}

function attachHandlers() {
  if (!elements) return;
  if (elements.fileInput) {
    elements.fileInput.addEventListener('change', handleFileSelection);
  }
  if (elements.confirmCancelButton) {
    elements.confirmCancelButton.addEventListener('click', () => {
      if (elements.fileInput) {
        elements.fileInput.value = '';
      }
      dfuState.file = null;
      dfuState.fileData = null;
      dfuState.fileImageInfo = null;
      updateFileMatchStatus();
      resetConfirmationState();
      updateCheckStatus(DfuFileCheckResult.emptyFileName);
      resetUploadProgress();
      resetUploadStatus();
      updateUploadButtons();
      showToast('DFU cancelled.');
    });
  }
  if (elements.confirmProceedButton) {
    elements.confirmProceedButton.addEventListener('click', () => {
      dfuState.userConfirmed = true;
      showConfirmationPanel(false);
      showUploadSection();
      updateUploadButtons();
      if (dfuState.connected) {
        refreshImageState();
      }
    });
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
  if (elements.reconnectButton) {
    elements.reconnectButton.addEventListener('click', () => {
      updateConnectionStatus('Reconnect requested...', '');
      connectForDfu(true);
    });
  }
  if (elements.waitingScanButton) {
    elements.waitingScanButton.addEventListener('click', async () => {
      try {
        if (!navigator.bluetooth || !navigator.bluetooth.requestDevice) {
          showToast('Bluetooth scan not supported in this browser.');
          return;
        }
        if (typeof window.connectToDevice !== 'function') {
          showToast('Main connection handler unavailable.');
          return;
        }
        const nameFilters = dfuState.deviceInfo?.deviceName ? [{ name: dfuState.deviceInfo.deviceName }] : [];
        const manufacturerFilter = { manufacturerData: [{ companyIdentifier: 0x0A61 }] };
        const filters = nameFilters.length
          ? nameFilters.map(nameFilter => ({ ...manufacturerFilter, ...nameFilter }))
          : [manufacturerFilter];
        const selected = await navigator.bluetooth.requestDevice({
          filters,
          optionalServices: [
            '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
            '8d53dc1d-1db7-4cd3-868b-8a527460aa84',
          ],
        });
        if (dfuState.mcumgr && dfuState.connected) {
          try {
            dfuState.mcumgr.disconnect();
          } catch (error) {
            logDfu(`DFU disconnect before scan reconnect failed: ${error.message || error}`, true);
          }
          await delay(400);
        }
        await window.connectToDevice(selected);
        setMainBleRefs(selected, window.server, window.rxCharacteristic, window.txCharacteristic);
        if (typeof window.requestStatusMessage === 'function') {
          await window.requestStatusMessage();
        }
        logDfu(`Main BLE state after connect: device=${Boolean(window.device)} gatt=${Boolean(window.device && window.device.gatt)} connected=${Boolean(window.device && window.device.gatt && window.device.gatt.connected)} rx=${Boolean(window.rxCharacteristic)}`);
        const mainConnected = await waitForMainConnection(8000);
        if (!mainConnected) {
          throw new Error('Main connection not ready yet.');
        }
        clearPendingDfu();
        setWaitingOverlayState({
          message: 'Reconnected. Ready to return to the device.',
          showSpinner: false,
          showCountdown: false,
          showReconnect: false,
          showContinue: true,
        });
      } catch (error) {
        if (error && error.name === 'NotFoundError') {
          resetDfuSession();
          setWaitingOverlay(false);
          if (typeof window.toggleDfuView === 'function') {
            window.toggleDfuView(false);
          }
          return;
        }
        showToast(`Scan failed: ${error.message || error}`);
      }
    });
  }
  if (elements.waitingContinueButton) {
    elements.waitingContinueButton.addEventListener('click', () => {
      returnToMainDeviceScreen();
    });
  }
  if (elements.resetSessionButton) {
    elements.resetSessionButton.addEventListener('click', resetDfuSession);
  }
  if (elements.finishButton) {
    elements.finishButton.addEventListener('click', async () => {
      if (typeof window.toggleDfuView === 'function') {
        window.toggleDfuView(false);
      }
      try {
        if (window.device && window.connectToDevice) {
          if (!window.device.gatt || !window.device.gatt.connected) {
            await window.connectToDevice(window.device);
          }
        }
        if (typeof window.requestStatusMessage === 'function') {
          await window.requestStatusMessage();
        }
      } catch (error) {
        logDfu(`Finish DFU failed: ${error.message || error}`, true);
      }
    });
  }
  if (elements.refreshStateButton) {
    elements.refreshStateButton.addEventListener('click', refreshImageState);
  }
  if (elements.testImageButton) {
    elements.testImageButton.addEventListener('click', testUploadedImage);
  }
  if (elements.confirmImageButton) {
    elements.confirmImageButton.addEventListener('click', confirmActiveImage);
  }
}

function resetUi() {
  if (!elements) return;
  resetUploadProgress();
  resetUploadStatus();
  updateUploadButtons();
  updateCheckStatus(dfuState.checkResult);
  updateFileMatchStatus();
  resetConfirmationState();
  clearPendingDfu();
}

function init(options = null) {
  if (!bindElements()) return;
  dfuState.existingDevice = options && options.device ? options.device : null;
  dfuState.useExistingConnection = options ? Boolean(options.useExistingConnection) : false;
  hydrateDeviceInfo();
  updateCheckStatus(DfuFileCheckResult.emptyFileName);
  setupMcuManager();
  applyUploadSettings();
  attachHandlers();
  resetUi();
  hydratePendingDfu();
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
  isAwaitingReboot: () => dfuState.awaitingReboot,
};
