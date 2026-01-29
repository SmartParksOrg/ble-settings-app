
// Opcodes
const MGMT_OP_READ = 0;
const MGMT_OP_READ_RSP = 1;
const MGMT_OP_WRITE = 2;
const MGMT_OP_WRITE_RSP = 3;

// Groups
const MGMT_GROUP_ID_OS = 0;
const MGMT_GROUP_ID_IMAGE = 1;
const MGMT_GROUP_ID_STAT = 2;
const MGMT_GROUP_ID_CONFIG = 3;
const MGMT_GROUP_ID_LOG = 4;
const MGMT_GROUP_ID_CRASH = 5;
const MGMT_GROUP_ID_SPLIT = 6;
const MGMT_GROUP_ID_RUN = 7;
const MGMT_GROUP_ID_FS = 8;
const MGMT_GROUP_ID_SHELL = 9;

// OS group
const OS_MGMT_ID_ECHO = 0;
const OS_MGMT_ID_CONS_ECHO_CTRL = 1;
const OS_MGMT_ID_TASKSTAT = 2;
const OS_MGMT_ID_MPSTAT = 3;
const OS_MGMT_ID_DATETIME_STR = 4;
const OS_MGMT_ID_RESET = 5;

// Image group
const IMG_MGMT_ID_STATE = 0;
const IMG_MGMT_ID_UPLOAD = 1;
const IMG_MGMT_ID_FILE = 2;
const IMG_MGMT_ID_CORELIST = 3;
const IMG_MGMT_ID_CORELOAD = 4;
const IMG_MGMT_ID_ERASE = 5;

class MCUManager {
    constructor(di = {}) {
        this.SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
        this.CHARACTERISTIC_UUID = 'da2e7828-fbce-4e01-ae9e-261174997c48';
        this._mtu = Number.isFinite(di.mtu) && di.mtu > 0 ? di.mtu : 240;
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._connectCallback = null;
        this._connectingCallback = null;
        this._disconnectCallback = null;
        this._messageCallback = null;
        this._imageUploadProgressCallback = null;
        this._imageUploadErrorCallback = null;
        this._uploadIsInProgress = false;
        this._initialChunkTimeout = Number.isFinite(di.chunkTimeout) && di.chunkTimeout > 0 ? di.chunkTimeout : 5000;
        this._chunkTimeout = this._initialChunkTimeout; // If sending a chunk is not completed in this time, it will be retried
        this._consecutiveTimeouts = 0;
        this._maxConsecutiveTimeouts = 2; // After this many timeouts, try increasing timeout
        this._maxTotalTimeouts = 6; // After this many total timeouts, give up
        this._totalTimeouts = 0;
        this._buffer = new Uint8Array();
        this._logger = di.logger || { info: console.log, error: console.error };
        this._seq = 0;
        this._userRequestedDisconnect = false;
        this._reconnectDelay = di.reconnectDelay || 1000;
        this._debugEnabled = Boolean(di.debug);
        this._autoReconnect = di.autoReconnect !== undefined ? Boolean(di.autoReconnect) : true;
        this._writeQueue = Promise.resolve();
        this._mtuFallbacks = Array.from(new Set((di.mtuFallbacks || [this._mtu, 200, 180, 160, 140, 120, 100, 80]).filter(value => Number.isFinite(value) && value >= 80)));
        this._mtuFallbackIndex = 0;
        this._lastAckOffset = null;
    }
    _debug(message, extra = null) {
        if (!this._debugEnabled) return;
        if (extra !== null) {
            this._logger.info(message, extra);
        } else {
            this._logger.info(message);
        }
    }
    setMtu(mtu) {
        if (Number.isFinite(mtu) && mtu > 0) {
            this._mtu = mtu;
        }
    }
    setChunkTimeout(timeoutMs) {
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            this._initialChunkTimeout = timeoutMs;
            this._chunkTimeout = timeoutMs;
        }
    }
    setDebugEnabled(enabled) {
        this._debugEnabled = Boolean(enabled);
    }
    getMtu() {
        return this._mtu;
    }
    getChunkTimeout() {
        return this._chunkTimeout;
    }
    getMtuFallbacks() {
        return this._mtuFallbacks.slice();
    }
    _handleUploadNextError(error) {
        const message = error && error.message ? error.message : String(error);
        this._uploadIsInProgress = false;
        this._logger.error(message);
        if (this._imageUploadErrorCallback) {
            this._imageUploadErrorCallback({
                error: message,
                consecutiveTimeouts: this._consecutiveTimeouts,
                totalTimeouts: this._totalTimeouts
            });
        }
    }
    async _requestDevice(filters) {
        const params = {
            acceptAllDevices: true,
            optionalServices: [this.SERVICE_UUID]
        };
        if (filters) {
            params.filters = filters;
            params.acceptAllDevices = false;
        }
        return navigator.bluetooth.requestDevice(params);
    }
    async connect(filters) {
        try {
            this._device = await this._requestDevice(filters);
            this._logger.info(`Connecting to device ${this.name}...`);
            this._device.addEventListener('gattserverdisconnected', async event => {
                this._logger.info(event);
                if (!this._userRequestedDisconnect && this._autoReconnect && this._device) {
                    this._logger.info('Trying to reconnect');
                    this._connect(this._reconnectDelay);
                } else {
                    this._disconnected();
                }
            });
            this._connect(0);
        } catch (error) {
            this._logger.error(error);
            await this._disconnected(error);
            return;
        }
    }
    async connectDevice(device, options = {}) {
        try {
            if (!device) {
                throw new Error('No device provided');
            }
            this._device = device;
            this._logger.info(`Connecting to device ${this.name}...`);
            this._device.addEventListener('gattserverdisconnected', async event => {
                this._logger.info(event);
                if (!this._userRequestedDisconnect && this._autoReconnect && this._device) {
                    this._logger.info('Trying to reconnect');
                    this._connect(this._reconnectDelay);
                } else {
                    this._disconnected();
                }
            });
            if (options.reuseConnection && this._device.gatt && this._device.gatt.connected) {
                this._logger.info('Using existing GATT connection.');
                try {
                    await this._connectToServer(this._device.gatt);
                } catch (error) {
                    this._logger.error(`Existing GATT reuse failed: ${error && error.message ? error.message : error}`);
                    this._connect(0);
                }
            } else {
                this._connect(0);
            }
        } catch (error) {
            this._logger.error(error);
            await this._disconnected(error);
            return;
        }
    }
    async _connectToServer(server) {
        if (!server) {
            throw new Error('No GATT server available');
        }
        if (this._connectingCallback) this._connectingCallback();
        this._logger.info(`Server connected.`);
        this._service = await server.getPrimaryService(this.SERVICE_UUID);
        this._logger.info(`Service connected.`);
        this._characteristic = await this._service.getCharacteristic(this.CHARACTERISTIC_UUID);
        this._characteristic.addEventListener('characteristicvaluechanged', this._notification.bind(this));
        await this._characteristic.startNotifications();
        await this._connected();
        if (this._uploadIsInProgress) {
            this._uploadNext().catch(error => this._handleUploadNextError(error));
        }
    }
    _connect(delay = 1000) {
        setTimeout(async () => {
            try {
                if (!this._device || !this._device.gatt) {
                    throw new Error('No GATT device available');
                }
                const server = await this._device.gatt.connect();
                await this._connectToServer(server);
            } catch (error) {
                this._logger.error(error);
                // Only show error to user on initial connection attempt, not on reconnection attempts
                await this._disconnected(delay === 0 ? error : null);
            }
        }, delay);
    }
    disconnect() {
        this._userRequestedDisconnect = true;
        if (!this._device || !this._device.gatt) return;
        return this._device.gatt.disconnect();
    }
    onConnecting(callback) {
        this._connectingCallback = callback;
        return this;
    }
    onConnect(callback) {
        this._connectCallback = callback;
        return this;
    }
    onDisconnect(callback) {
        this._disconnectCallback = callback;
        return this;
    }
    onMessage(callback) {
        this._messageCallback = callback;
        return this;
    }
    onImageUploadProgress(callback) {
        this._imageUploadProgressCallback = callback;
        return this;
    }
    onImageUploadFinished(callback) {
        this._imageUploadFinishedCallback = callback;
        return this;
    }
    onImageUploadError(callback) {
        this._imageUploadErrorCallback = callback;
        return this;
    }
    onImageUploadChunkAck(callback) {
        this._imageUploadChunkAckCallback = callback;
        return this;
    }
    onImageUploadCancelled(callback) {
        this._imageUploadCancelledCallback = callback;
        return this;
    }
    async _connected() {
        if (this._connectCallback) this._connectCallback();
    }
    async _disconnected(error = null) {
        this._logger.info('Disconnected.');
        if (this._disconnectCallback) this._disconnectCallback(error);
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._uploadIsInProgress = false;
        this._userRequestedDisconnect = false;
    }
    get name() {
        return this._device && this._device.name;
    }
    async _sendMessage(op, group, id, data) {
        if (!this._characteristic) {
            throw new Error('GATT characteristic not ready');
        }
        const _flags = 0;
        let encodedData = [];
        if (typeof data !== 'undefined') {
            encodedData = [...new Uint8Array(CBOR.encode(data))];
        }
        const length_lo = encodedData.length & 255;
        const length_hi = encodedData.length >> 8;
        const group_lo = group & 255;
        const group_hi = group >> 8;
        const message = [op, _flags, length_hi, length_lo, group_hi, group_lo, this._seq, id, ...encodedData];
        // console.log('>'  + message.map(x => x.toString(16).padStart(2, '0')).join(' '));
        this._writeQueue = this._writeQueue.then(async () => {
            try {
                await this._characteristic.writeValueWithoutResponse(Uint8Array.from(message));
            } catch (error) {
                this._logger.error(`GATT write failed: ${error && error.message ? error.message : error}`);
                throw error;
            }
        });
        await this._writeQueue;
        this._seq = (this._seq + 1) % 256;
    }
    _notification(event) {
        const value = event.target.value;
        const message = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        this._buffer = new Uint8Array([...this._buffer, ...message]);
        if (this._buffer.length < 4) return;
        const messageLength = this._buffer[2] * 256 + this._buffer[3];
        if (this._buffer.length < messageLength + 8) return;
        this._processMessage(this._buffer.slice(0, messageLength + 8));
        this._buffer = this._buffer.slice(messageLength + 8);
    }
    _processMessage(message) {
        const [op, _flags, length_hi, length_lo, group_hi, group_lo, _seq, id] = message;
        let data = null;
        try {
            data = CBOR.decode(message.slice(8).buffer);
        } catch (error) {
            this._logger.error(`CBOR decode failed: ${error && error.message ? error.message : error}`);
            this._buffer = new Uint8Array();
            return;
        }
        const length = length_hi * 256 + length_lo;
        const group = group_hi * 256 + group_lo;

        this._debug('[MCUManager DEBUG] Message received:', {
            op,
            group,
            id,
            length,
            dataKeys: data ? Object.keys(data) : 'null',
            data: data
        });

        if (group === MGMT_GROUP_ID_IMAGE && id === IMG_MGMT_ID_UPLOAD) {
            // Clear timeout since we received a response
            if (this._uploadTimeout) {
                clearTimeout(this._uploadTimeout);
            }

            // Check for error response
            if (data.rc && data.rc !== 0) {
                this._uploadIsInProgress = false;
                const errorMessages = {
                    1: 'Unknown error',
                    2: 'Slot is busy or in bad state. Try erasing the slot first or confirming/testing pending images.',
                    3: 'Invalid value',
                    4: 'Operation timeout',
                    5: 'No entry found',
                    6: 'Bad state',
                    7: 'Response too large',
                    8: 'Not supported',
                    9: 'Data is corrupt',
                    10: 'Device is busy'
                };
                const errorMsg = errorMessages[data.rc] || `Device returned error code ${data.rc}`;
                this._logger.error(`Upload failed: ${errorMsg}`);
                if (this._imageUploadErrorCallback) {
                    this._imageUploadErrorCallback({
                        error: `Upload failed: ${errorMsg}`,
                        errorCode: data.rc,
                        consecutiveTimeouts: this._consecutiveTimeouts,
                        totalTimeouts: this._totalTimeouts
                    });
                }
                return;
            }

            // Success response with offset
            if ((data.rc === 0 || data.rc === undefined) && data.off !== undefined) {
                // Reset consecutive timeout counter on successful response
                this._consecutiveTimeouts = 0;
                this._lastAckOffset = data.off;
                if (this._imageUploadChunkAckCallback) {
                    this._imageUploadChunkAckCallback({ off: data.off });
                }
                this._uploadOffset = data.off;
                this._debug(`[MCUManager DEBUG] Upload progress: device offset ${data.off}`);
                this._uploadNext().catch(error => this._handleUploadNextError(error));
                return;
            }
        }
        if (this._messageCallback) this._messageCallback({ op, group, id, data, length });
    }
    cmdReset() {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_OS, OS_MGMT_ID_RESET);
    }
    smpEcho(message) {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_OS, OS_MGMT_ID_ECHO, { d: message });
    }
    cmdImageState() {
        return this._sendMessage(MGMT_OP_READ, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE);
    }
    cmdImageErase() {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_ERASE, {});
    }
    cmdImageTest(hash) {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, { hash, confirm: false });
    }
    cmdImageConfirm(hash) {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, { hash, confirm: true });
    }
    _hash(image) {
        return crypto.subtle.digest('SHA-256', image);
    }
    async _uploadNext() {
        if (this._uploadOffset >= this._uploadImage.byteLength) {
            this._uploadIsInProgress = false;
            this._imageUploadFinishedCallback();
            return;
        }

        // Clear any existing timeout
        if (this._uploadTimeout) {
            clearTimeout(this._uploadTimeout);
        }
        // Set new timeout
        this._uploadTimeout = setTimeout(() => {
            this._consecutiveTimeouts++;
            this._totalTimeouts++;

            this._debug(`[MCUManager DEBUG] Upload chunk timeout at offset ${this._uploadOffset} (consecutive: ${this._consecutiveTimeouts}, total: ${this._totalTimeouts})`);
            this._logger.info(`DFU: Chunk timeout off=${this._uploadOffset} consecutive=${this._consecutiveTimeouts} total=${this._totalTimeouts}`);

            const noProgress = this._lastAckOffset === this._uploadOffset;
            if (noProgress && this._mtuFallbackIndex < this._mtuFallbacks.length - 1) {
                this._mtuFallbackIndex += 1;
                this._mtu = this._mtuFallbacks[this._mtuFallbackIndex];
                this._logger.info(`DFU: No progress; retrying with lower MTU (${this._mtu}).`);
                this._consecutiveTimeouts = 0;
                this._totalTimeouts = 0;
                this._chunkTimeout = this._initialChunkTimeout;
                this._uploadNext().catch(error => this._handleUploadNextError(error));
                return;
            }

            // If we've hit too many total timeouts, attempt MTU fallback before giving up
            if (this._totalTimeouts >= this._maxTotalTimeouts) {
                if (this._uploadOffset === 0 && this._mtuFallbackIndex < this._mtuFallbacks.length - 1) {
                    this._mtuFallbackIndex += 1;
                    this._mtu = this._mtuFallbacks[this._mtuFallbackIndex];
                    this._logger.info(`No upload response; retrying with lower MTU (${this._mtu}).`);
                    this._consecutiveTimeouts = 0;
                    this._totalTimeouts = 0;
                    this._chunkTimeout = this._initialChunkTimeout;
                    this._uploadNext().catch(error => this._handleUploadNextError(error));
                    return;
                }
                this._uploadIsInProgress = false;
                const error = `Upload failed: Device not responding after ${this._totalTimeouts} attempts. The device may be too slow or disconnected.`;
                this._logger.error(error);
                if (this._imageUploadErrorCallback) {
                    this._imageUploadErrorCallback({ error, consecutiveTimeouts: this._consecutiveTimeouts, totalTimeouts: this._totalTimeouts });
                }
                return;
            }

            // If we've had several consecutive timeouts, increase the timeout duration
            if (this._consecutiveTimeouts >= this._maxConsecutiveTimeouts) {
                this._chunkTimeout = Math.min(this._chunkTimeout * 2, 15000); // Max 15 seconds
                this._debug(`[MCUManager DEBUG] Increased chunk timeout to ${this._chunkTimeout}ms`);
                this._logger.info(`DFU: Timeout adjusted to ${this._chunkTimeout}ms at ${Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100)}%`);
                // Notify UI about timeout adjustment
                if (this._imageUploadProgressCallback) {
                    this._imageUploadProgressCallback({
                        percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100),
                        timeoutAdjusted: true,
                        newTimeout: this._chunkTimeout
                    });
                }
            }

            this._uploadNext().catch(error => this._handleUploadNextError(error));
        }, this._chunkTimeout);

        const nmpOverhead = 8;
        const baseMessage = { off: this._uploadOffset };
        if (this._uploadOffset === 0) {
            baseMessage.len = this._uploadImage.byteLength;
            baseMessage.sha = new Uint8Array(await this._hash(this._uploadImage));
        }
        this._imageUploadProgressCallback({ percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100) });

        const remaining = this._uploadImage.byteLength - this._uploadOffset;
        const budget = this._mtu;
        let dataLen = Math.min(remaining, budget);
        let message = null;
        let encoded = null;
        let packetSize = 0;

        while (dataLen >= 0) {
            message = { ...baseMessage };
            message.data = new Uint8Array(this._uploadImage.slice(this._uploadOffset, this._uploadOffset + dataLen));
            encoded = CBOR.encode(message);
            packetSize = nmpOverhead + encoded.byteLength;
            if (packetSize <= budget) {
                break;
            }
            if (dataLen === 0) {
                break;
            }
            dataLen = Math.max(0, dataLen - 16);
        }

        if (packetSize > budget) {
            throw new Error(`Upload packet cannot fit within MTU budget (${budget} bytes) even with empty data. Increase the MTU budget or reduce overhead.`);
        }

        this._debug(`[MCUManager DEBUG] Upload chunk: off=${this._uploadOffset}, dataLen=${dataLen}, packetSize=${packetSize}, budget=${budget}`);
        this._logger.info(`DFU: Sending chunk off=${this._uploadOffset} len=${dataLen} mtu=${budget}`);
        if (this._lastAckOffset === null) {
            this._lastAckOffset = this._uploadOffset;
        }

        // Keep offset for retry
        // this._uploadOffset += dataLen;

        this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, message)
            .catch(error => this._handleUploadNextError(error));
    }
    async cmdUpload(image, slot = 0) {
        if (this._uploadIsInProgress) {
            this._logger.error('Upload is already in progress.');
            return;
        }
        if (!this._characteristic) {
            const error = 'Cannot start upload: GATT characteristic not ready.';
            this._logger.error(error);
            if (this._imageUploadErrorCallback) {
                this._imageUploadErrorCallback({ error, consecutiveTimeouts: 0, totalTimeouts: 0 });
            }
            return;
        }
        this._uploadIsInProgress = true;

        this._uploadOffset = 0;
        this._uploadImage = image;
        this._uploadSlot = slot;
        this._mtuFallbackIndex = 0;
        this._lastAckOffset = null;

        // Reset timeout tracking
        this._consecutiveTimeouts = 0;
        this._totalTimeouts = 0;
        this._chunkTimeout = this._initialChunkTimeout; // Reset to initial value

        this._debug(`[MCUManager DEBUG] Upload config: mtu=${this._mtu} bytes, timeout=${this._chunkTimeout}ms`);
        this._logger.info(`DFU: Upload begin len=${image.byteLength} mtu=${this._mtu} timeout=${this._chunkTimeout}ms`);

        this._uploadNext().catch(error => this._handleUploadNextError(error));
    }
    cancelUpload() {
        if (!this._uploadIsInProgress) {
            return;
        }

        // Clear timeout
        if (this._uploadTimeout) {
            clearTimeout(this._uploadTimeout);
        }

        // Reset upload state
        this._uploadIsInProgress = false;
        this._uploadOffset = 0;
        this._uploadImage = null;
        this._consecutiveTimeouts = 0;
        this._totalTimeouts = 0;

        this._debug('[MCUManager DEBUG] Upload cancelled by user');

        // Notify callback
        if (this._imageUploadCancelledCallback) {
            this._imageUploadCancelledCallback();
        }
    }
    // Given an ArrayBuffer, extract Tag-Value pairs and return them one by one.
    *_extractTlvs(data) {
        const view = new DataView(data);
        let offset = 0;
        while (offset < view.byteLength) {
            const tag = view.getUint16(offset, true);
            const len = view.getUint16(offset + 2, true);
            offset += 4;
            const valueData = view.buffer.slice(offset, offset + len);
            offset += len;

            yield { tag, value: new Uint8Array(valueData) };
        }
    }
    async imageInfo(image) {
        // https://interrupt.memfault.com/blog/mcuboot-overview#mcuboot-image-binaries

        const info = {};
        info.tags = {};
        const view = new DataView(image);

        // check header length
        if (view.length < 32) {
            throw new Error('Invalid image (too short file)');
        }

        // check MAGIC bytes 0x96f3b83d
        if (view.getUint32(0, true) !== 0x96f3b83d) {
            throw new Error('Invalid image (wrong magic bytes)');
        }

        // check load address is 0x00000000
        if (view.getUint32(4, true) !== 0) {
            throw new Error('Invalid image (wrong load address)');
        }

        const headerSize = view.getUint16(8, true);

        // Protected TLV area is included in the hash
        const protected_tlv_length = view.getUint16(10, true);

        const imageSize = view.getUint32(12, true);
        info.imageSize = imageSize;

        // check image size is correct
        if (view.length < imageSize + headerSize) {
            throw new Error('Invalid image (wrong image size)');
        }

        // check flags is 0x00000000
        if (view.getUint32(16, true) !== 0x00) {
            throw new Error('Invalid image (wrong flags)');
        }

        const version = `${view.getUint8(20)}.${view.getUint8(21)}.${view.getUint16(22, true)}`;
        info.version = version;

        const hashBytes = new Uint8Array(await this._hash(image.slice(0, imageSize + headerSize + protected_tlv_length)));
        info.hash = [...hashBytes].map(b => b.toString(16).padStart(2, '0')).join('');

        let offset = headerSize + imageSize;
        let tlv_end = offset;

        // Only if it was indicated that there were protected TLVs
        if (protected_tlv_length > 0) {
            // Verify the protected TLV magic bytes are valid.
            if (view.getUint16(offset, true) !== 0x6908) {
                throw new Error( `Expected protected TLV magic number. (0x${offset.toString(16)}: 0x${view.getUint16(offset, true).toString(16)})`);
            }

            // Find the end of the protected TLV region
            tlv_end = view.getUint16(offset + 2, true) + offset;
            // Store all tag-value pairs for the protected TLV region.
            for (let tlv of this._extractTlvs(view.buffer.slice(offset + 4, tlv_end))) {
                info.tags[tlv.tag] = tlv.value;
            }
            offset = tlv_end;
        }

        // The non-protected TLV region must be here.
        if (view.getUint16(offset, true) !== 0x6907) {
            throw new Error(`Expected TLV magic number. (0x${offset.toString(16)}: 0x${view.getUint16(offset, true).toString(16)})`);
        }

        // Also include the non-protected TLVs in the tags map.
        // Assume there are no overlapping tag Ids.
        tlv_end = view.getUint16(offset + 2, true) + offset;
        for (let tlv of this._extractTlvs(view.buffer.slice(offset + 4, tlv_end))) {
            info.tags[tlv.tag] = tlv.value;
        }

        // If the image hash tag is present, verify it matches what was calculated earlier.
        if (16 in info.tags && info.tags[16].length == hashBytes.length) {
            info.hashValid = info.tags[16].every((b, i) => b === hashBytes[i]);
        }

        return info;
    }
}

// Export for Node.js (testing) while keeping browser compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MCUManager,
        MGMT_OP_READ,
        MGMT_OP_READ_RSP,
        MGMT_OP_WRITE,
        MGMT_OP_WRITE_RSP,
        MGMT_GROUP_ID_OS,
        MGMT_GROUP_ID_IMAGE,
        MGMT_GROUP_ID_STAT,
        MGMT_GROUP_ID_CONFIG,
        MGMT_GROUP_ID_LOG,
        MGMT_GROUP_ID_CRASH,
        MGMT_GROUP_ID_SPLIT,
        MGMT_GROUP_ID_RUN,
        MGMT_GROUP_ID_FS,
        MGMT_GROUP_ID_SHELL,
        OS_MGMT_ID_ECHO,
        OS_MGMT_ID_CONS_ECHO_CTRL,
        OS_MGMT_ID_TASKSTAT,
        OS_MGMT_ID_MPSTAT,
        OS_MGMT_ID_DATETIME_STR,
        OS_MGMT_ID_RESET,
        IMG_MGMT_ID_STATE,
        IMG_MGMT_ID_UPLOAD,
        IMG_MGMT_ID_FILE,
        IMG_MGMT_ID_CORELIST,
        IMG_MGMT_ID_CORELOAD,
        IMG_MGMT_ID_ERASE
    };
}
