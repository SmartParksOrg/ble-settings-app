let settingsData = null;
let settingsMap = new Map(); // maps int ID -> [key, meta]
const intervalPatterns = [
    /^(?!.*advertisement).*_interval\d?$/, // matches _interval, _interval1, _interval2, etc., but not _advertisement_interval
    /^rf_scan_duration$/,
    /^(cold|hot)_fix_timeout$/
];

const grouping = {
    "^(hot|cold)_": "satellite",
    "^sat_send_flag$": "satellite",
    "^rejoin_interval$": "lr",
    "^app_(key|eui)$": "lr",
    "^device_eui$": "lr",
    "^horizontal_accuracy$": "ublox",
    "^motion_ths$": "gps",
    "^enable_motion_trig_gps$": "gps",
    "^rf_open_sky_detection": 0,
    "^rf_scan": 0,
    "(^.{2,}?)_": 1
};

const bitmapSettings = [/^.*_flag$/];

const skipPorts = ['port_lr_messaging', 'port_flash_log', 'port_values', 'port_messages', 'port_commands'];
const customByteArrayRenderers = {
    lp0_communication_params: renderLp0CommunicationParams,
    lp0_node_params: renderLp0NodeParams
};

// Static list of settings files
const SETTINGS_FILES = [
    "settings_testing_1.json",
    "settings-v6.15.0.json",
    "settings-v6.14.1.json",
    "settings-v6.12.1.json",
    "settings-v6.11.0.json",
    "settings-v6.10.0.json",
    "settings-v6.9.0.json",
    "settings-v6.8.1.json",
    "settings-v4.4.2.json"
];

const dangerousCommands = [/_th$/, /set_hibernation_mode/, /almanac_update/];

const minMaxValues = {
    'uint8': { min: 0, max: 255 },
    'uint16': { min: 0, max: 65535 },
    'uint32': { min: 0, max: 4294967295 },
    'int8': { min: -128, max: 127 },
    'int32': { min: -2147483648, max: 2147483647 },
    'float': { min: -3.4e38, max: 3.4e38 }
}

function populateSettingsIntoPage(firstItem = null) {
    const dropdown = document.getElementById('settings-dropdown');
    dropdown.innerHTML = ''; // Clear previous options

    if (firstItem) {
        const option = document.createElement('option');
        option.value = "";
        option.textContent = firstItem;
        dropdown.appendChild(option);
    }

    SETTINGS_FILES.forEach(file => {
        const option = document.createElement('option');
        option.value = `./settings/${file}`;
        option.textContent = file;
        dropdown.appendChild(option);
    });
}

async function loadSettings(selectedFile) {
    settingsData = null;
    settingsMap = new Map();

    try {
        const response = await fetch(selectedFile);
        settingsData = await response.json();

        settingsMap = new Map();
        registerValues(settingsData.settings, "setting");
        registerValues(settingsData.commands, "command");
    } catch (error) {
        throw new Error(`Error loading settings: ${error.message}`);
    }
}

function __onInputChanged(settingId) {
    const [key, setting] = getById(settingId);
    const value = getInputValue(setting.id);
    const errorElement = document.getElementById(`input-error-${setting.id}`);

    let valid = true;
    try {
        validateInput(setting, value);
        errorElement.innerText = '';
    } catch (error) {
        valid = false;
        errorElement.innerText = error.message;
    }

    if (typeof (onInputChanged) === typeof (Function)) {
        onInputChanged(setting, value, valid);
    }
}

function setInputValue(settingId, value) {
    const [key, setting] = getById(settingId);
    document.getElementById(`input-container-${settingId}`).innerHTML = renderInputControl(key, setting, value);
}

function clearInputValue(settingId) {
    document.getElementById(`input-container-${settingId}`).innerHTML = '';
}

function setDefaultValue(settingId) {
    const [key, setting] = getById(settingId);
    document.getElementById(`input-container-${settingId}`).innerHTML = renderInputControl(key, setting, setting.default);
}

function getInputValue(settingId) {
    const el = document.getElementById(`new-value-${settingId}`);
    if (el) {
        return el.value.trim();
    }
}

function filterSettings() {
    const query = document.getElementById('settings-search').value.toLowerCase();
    const showNonDefaultOnly = document.getElementById('non-default-checkbox') ? document.getElementById('non-default-checkbox').checked : false;
    const settingsSection = document.getElementById('settings-section');
    const groups = settingsSection.querySelectorAll('.settings-group');

    groups.forEach(group => {
        const settingsContainer = group.querySelector('.settings-container');
        const groupToggle = group.querySelector('.group-toggle');
        let hasVisibleSettings = false;
        const settings = settingsContainer ? settingsContainer.querySelectorAll('.setting') : [];

        settings.forEach(setting => {
            const dataSearch = setting.getAttribute('data-search') || setting.querySelector('h4').textContent;
            const matchesSearch = dataSearch.toLowerCase().includes(query);
            const isNonDefault = setting.classList.contains('value-not-default');
            const shouldShow = matchesSearch && (!showNonDefaultOnly || isNonDefault);

            if (shouldShow) {
                setting.classList.remove('hidden');
                hasVisibleSettings = true;
            } else {
                setting.classList.add('hidden');
            }
        });

        if (hasVisibleSettings) {
            group.classList.remove('hidden');
            if (query || showNonDefaultOnly) {
                group.classList.remove('is-collapsed');
                if (groupToggle) {
                    groupToggle.setAttribute('aria-expanded', 'true');
                }
            }
        } else {
            group.classList.add('hidden');
        }
    });
}

function toggleGroup(group) {
    const isCollapsed = group.classList.toggle('is-collapsed');
    const groupToggle = group.querySelector('.group-toggle');
    if (groupToggle) {
        groupToggle.setAttribute('aria-expanded', (!isCollapsed).toString());
    }
}


function registerValues(data, type) {
    for (const [key, value] of Object.entries(data)) {
        // key is the string name of the setting
        // value includes: id, default, min, max, conversion, etc.
        value["type"] = type;
        settingsMap.set(parseInt(value.id, 16), [key, value]);
    }
}

function getByKey(key) {
    return settingsData.settings[key];
}

function getById(id) {
    if (typeof id === 'string' || id instanceof String) {
        id = parseInt(id, 16);
    }

    if (!settingsMap.has(id)) {
        throw new Error(`Value with ID ${toHex(id)} not found`);
    }

    return settingsMap.get(id);
}

function isBitmaskSetting(key) {
    return bitmapSettings.some(rx => rx.test(key));
}

function convertUnitToSeconds(value, unit) {
    return value * parseInt(unit, 10);
}

function convertSecondsToUnit(valueInSeconds, unit) {
    return valueInSeconds / parseInt(unit);
}

function stripBytes(s) {
    return s.replace(/0x/g, '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

function renderPortCheckboxes(setting, value) {
    const defaultVal = parseInt(value || 0, 10);
    let html = `
          <!-- hidden field to store the final bitmask -->
          <input type="hidden" id="new-value-${setting.id}" value="${defaultVal}" />
          <div class="checkbox-scroll">
        `;
    for (const [portName, portNum] of Object.entries(settingsData.ports)) {
        if (skipPorts.includes(portName)) {
            continue;
        }

        const bitIsSet = (defaultVal & (1 << (portNum - 1))) !== 0;
        const checkboxId = `${portName}-${setting.id}`;
        html += `
            <div class="checkbox-container">
              <input type="checkbox"
                id="${checkboxId}"
                onchange="updateBitmaskForSetting('${setting.id}')"
                ${bitIsSet ? 'checked' : ''}
              />
              <label for="${checkboxId}">${portName.replace(/^port_/, "")}</label>
            </div>
          `;
    }
    html += `</div>`;
    return html;
}

function renderIntervalSetting(key, setting, value) {
    const defaultSeconds = parseInt(value || 0, 10);

    // Guess a default unit based on the numeric value:
    // >=86400 => days, >=3600 => hours, >=60 => minutes, else seconds
    const guessedUnit = guessTimeUnit(defaultSeconds);
    // Convert the default seconds into that guessed unit
    const displayValueInGuessedUnit = Math.round(convertSecondsToUnit(defaultSeconds, guessedUnit));

    return `
        <!-- hidden actual seconds value -->
        <input type="hidden" id="new-value-${setting.id}" value="${defaultSeconds}" />
        <div class="interval-container">
            <!-- The numeric input displayed to user -->
            <input type="number"
            id="interval-num-${setting.id}"
            oninput="updateIntervalValue('${setting.id}')"
            value="${displayValueInGuessedUnit}" />

            <!-- The time unit select, with guessedUnit pre-selected -->
            <select id="interval-unit-${setting.id}"
            onchange="updateIntervalUnit('${setting.id}')">
            <option value="1"${guessedUnit === '1' ? ' selected' : ''}>second(s)</option>
            <option value="60"${guessedUnit === '60' ? ' selected' : ''}>minute(s)</option>
            <option value="3600"${guessedUnit === '3600' ? ' selected' : ''}>hour(s)</option>
            <option value="86400"${guessedUnit === '86400' ? ' selected' : ''}>day(s)</option>
            </select>
        </div>
      `;
}

function guessTimeUnit(seconds) {
    if (seconds >= 86400 && (seconds % 86400 === 0)) {
        return '86400';
    } else if (seconds >= 3600 && (seconds % 3600 === 0)) {
        return '3600';
    } else if (seconds >= 60 && (seconds % 60 === 0)) {
        return '60';
    }
    return '1';
}

function formatSettingName(settingName, group) {
    if (settingName.startsWith(group + "_")) {
        settingName = settingName.replace(group + "_", "");
    }

    return settingName;
}

function getGroupName(key) {
    for (const [rx, groupName] of Object.entries(grouping)) {
        const match = key.match(rx);
        if (match) {
            if (typeof groupName === 'number') {
                return match[groupName];
            } else {
                return groupName;
            }
        }
    }
    return key;
}

function groupAndSortSettings() {
    const grouped = {};
    const other = {};

    for (const key in settingsData.settings) {
        const groupName = getGroupName(key);
        if (!grouped[groupName]) {
            grouped[groupName] = {};
        }
        grouped[groupName][key] = settingsData.settings[key];
    }

    // Move singletons into "_other"
    for (const prefix in grouped) {
        if (Object.keys(grouped[prefix]).length === 1) {
            const [singleKey] = Object.keys(grouped[prefix]);
            other[singleKey] = grouped[prefix][singleKey];
            delete grouped[prefix];
        }
    }

    if (Object.keys(other).length > 0) {
        grouped["_other"] = other;
    }

    for (const groupName in grouped) {
        for (const key in grouped[groupName]) {
            grouped[groupName][key].display_name = formatSettingName(key, groupName);
        }
    }

    // Sort groups
    const sortedGroups = Object.keys(grouped).sort().reduce((acc, group) => {
        acc[group] = Object.keys(grouped[group]).sort((a, b) => {
            const nameA = grouped[group][a].display_name.toLowerCase();
            const nameB = grouped[group][b].display_name.toLowerCase();
            return nameA.localeCompare(nameB);
        }).reduce((groupAcc, key) => {
            groupAcc[key] = grouped[group][key];
            return groupAcc;
        }, {});
        return acc;
    }, {});

    return sortedGroups;
}

function renderInput(key, setting) {
    if (setting.length === 0) {
        return '';
    }

    return `<div class="input-container" id="input-container-${setting.id}">${renderInputControl(key, setting, setting.default)}</div>`;
}

function renderInputContainer(key, setting) {
    return `<div class="input-container" id="input-container-${setting.id}"></div>`;
}

function renderInputControl(key, setting, value) {
    if (setting.length === 0) {
        return '';
    }

    if (value === undefined) {
        value = "";
    }

    // Build the "include" checkbox + label
    let html = '';

    // 0) Special byte array renderers
    if (customByteArrayRenderers[key]) {
        value = stripBytes(value);
        html += customByteArrayRenderers[key](setting, value);
    }

    // 1) If it's one of the three bitmask settings -> render port checkboxes
    else if (isBitmaskSetting(key) && setting.conversion === 'uint32') {
        html += renderPortCheckboxes(setting, value);
    }

    // 2) If the key ends with "_interval" -> render numeric + time-unit select (with auto-guess)
    else if (intervalPatterns.some(rx => rx.test(key))) {
        html += renderIntervalSetting(key, setting, value);
    }

    // 3) If it's a normal bool
    else if (setting.conversion === 'bool') {
        html += `<select id="new-value-${setting.id}" onchange="__onInputChanged('${setting.id}')">`;
        if (value) {
            html += `<option value="true" selected>true</option><option value="false">false</option>`;
        } else {
            html += `<option value="true">true</option><option value="false" selected>false</option>`;
        }
        html += `</select>`;
    }

    // 4) If it's a normal numeric input
    else if (['uint32', 'uint16', 'uint8', 'int32', 'int8', 'float'].includes(setting.conversion)) {
        const min = setting.min != undefined ? setting.min : minMaxValues[setting.conversion].min;
        const max = setting.max != undefined ? setting.max : minMaxValues[setting.conversion].max;
        html += `<input
         type="number"
         id="new-value-${setting.id}"
         min="${min}"
         max="${max}"
         step="${setting.conversion === 'float' ? '0.01' : '1'}"
         value="${value}"
         oninput="__onInputChanged('${setting.id}')"
       />`;
    }

    // 5) If it's a byte_array
    else if (setting.conversion === 'byte_array') {
        value = stripBytes(value);
        html += `<textarea id="new-value-${setting.id}" rows="4" oninput="__onInputChanged('${setting.id}')">${value}</textarea>`;
    }

    // 6) If it's a string
    else if (setting.conversion === 'string') {
        html += `<input type="text" id="new-value-${setting.id}" value="${value}" oninput="__onInputChanged('${setting.id}')"/>`;
    }

    // 7) Otherwise unknown/custom, default to text
    else {
        html += `<input type="text" id="new-value-${setting.id}" value="${value}" oninput="__onInputChanged('${setting.id}')"/>`;
    }

    let errorText = '';
    try {
        validateInput(setting, value);
    } catch (error) {
        errorText = error.message;
    }

    html += `<div class="input-error" id="input-error-${setting.id}">${errorText}</div>`; // close input-container

    return html;
}

function parseByteArrayValue(value, expectedLength) {
    const hex = stripBytes(value || '');
    const bytes = new Uint8Array(expectedLength);
    for (let i = 0; i < expectedLength; i++) {
        const start = i * 2;
        if (start + 2 <= hex.length) {
            bytes[i] = parseInt(hex.substr(start, 2), 16);
        } else {
            bytes[i] = 0;
        }
    }
    return bytes;
}

function renderByteArrayField(settingId, index, label, value, options, helpText, readOnly) {
    const inputId = `byte-${settingId}-${index}`;
    const control = options
        ? `<select id="${inputId}" onchange="updateLp0ByteArray('${settingId}')">
            ${options.map(option => `<option value="${option.value}"${option.value === value ? ' selected' : ''}>${option.label}</option>`).join('')}
           </select>`
        : `<input type="number"
            id="${inputId}"
            min="0"
            max="255"
            value="${value}"
            ${readOnly ? 'readonly' : ''}
            oninput="updateLp0ByteArray('${settingId}')"
          />`;

    return `
        <div class="byte-array-field">
            <label for="${inputId}">${label}</label>
            ${control}
            ${helpText ? `<div class="byte-array-help">${helpText}</div>` : ''}
        </div>
    `;
}

function renderLp0CommunicationParams(setting, value) {
    const bytes = parseByteArrayValue(value, setting.length);
    return `
        <input type="hidden" id="new-value-${setting.id}" value="${bytesToHex(bytes)}" />
        <div class="byte-array-grid">
            ${renderByteArrayField(setting.id, 0, 'Spreading factor', bytes[0], [
                { value: 0x05, label: 'LR11XX_RADIO_LORA_SF5 (0x05)' },
                { value: 0x06, label: 'LR11XX_RADIO_LORA_SF6 (0x06)' },
                { value: 0x07, label: 'LR11XX_RADIO_LORA_SF7 (0x07)' },
                { value: 0x08, label: 'LR11XX_RADIO_LORA_SF8 (0x08)' },
                { value: 0x09, label: 'LR11XX_RADIO_LORA_SF9 (0x09)' },
                { value: 0x0A, label: 'LR11XX_RADIO_LORA_SF10 (0x0A)' },
                { value: 0x0B, label: 'LR11XX_RADIO_LORA_SF11 (0x0B)' },
                { value: 0x0C, label: 'LR11XX_RADIO_LORA_SF12 (0x0C)' }
            ], 'Default: LR11XX_RADIO_LORA_SF9 (0x09)')}
            ${renderByteArrayField(setting.id, 1, 'Bandwidth', bytes[1], [
                { value: 0x08, label: 'LR11XX_RADIO_LORA_BW_10 (10.42 kHz, 0x08)' },
                { value: 0x01, label: 'LR11XX_RADIO_LORA_BW_15 (15.63 kHz, 0x01)' },
                { value: 0x09, label: 'LR11XX_RADIO_LORA_BW_20 (20.83 kHz, 0x09)' },
                { value: 0x02, label: 'LR11XX_RADIO_LORA_BW_31 (31.25 kHz, 0x02)' },
                { value: 0x0A, label: 'LR11XX_RADIO_LORA_BW_41 (41.67 kHz, 0x0A)' },
                { value: 0x03, label: 'LR11XX_RADIO_LORA_BW_62 (62.50 kHz, 0x03)' },
                { value: 0x04, label: 'LR11XX_RADIO_LORA_BW_125 (125.00 kHz, 0x04)' },
                { value: 0x05, label: 'LR11XX_RADIO_LORA_BW_250 (250.00 kHz, 0x05)' },
                { value: 0x06, label: 'LR11XX_RADIO_LORA_BW_500 (500.00 kHz, 0x06)' },
                { value: 0x0D, label: 'LR11XX_RADIO_LORA_BW_200 (203.00 kHz, 0x0D)' },
                { value: 0x0E, label: 'LR11XX_RADIO_LORA_BW_400 (406.00 kHz, 0x0E)' },
                { value: 0x0F, label: 'LR11XX_RADIO_LORA_BW_800 (812.00 kHz, 0x0F)' }
            ], 'Default: LR11XX_RADIO_LORA_BW_125 (0x04)')}
            ${renderByteArrayField(setting.id, 2, 'Coding rate', bytes[2], [
                { value: 0x00, label: 'LR11XX_RADIO_LORA_NO_CR (0x00)' },
                { value: 0x01, label: 'LR11XX_RADIO_LORA_CR_4_5 (0x01)' },
                { value: 0x02, label: 'LR11XX_RADIO_LORA_CR_4_6 (0x02)' },
                { value: 0x03, label: 'LR11XX_RADIO_LORA_CR_4_7 (0x03)' },
                { value: 0x04, label: 'LR11XX_RADIO_LORA_CR_4_8 (0x04)' },
                { value: 0x05, label: 'LR11XX_RADIO_LORA_CR_LI_4_5 (0x05)' },
                { value: 0x06, label: 'LR11XX_RADIO_LORA_CR_LI_4_6 (0x06)' },
                { value: 0x07, label: 'LR11XX_RADIO_LORA_CR_LI_4_8 (0x07)' }
            ], 'Default: LR11XX_RADIO_LORA_CR_4_5 (0x01)')}
            ${renderByteArrayField(setting.id, 3, 'RX1 window delay (seconds)', bytes[3], null, 'Must match across devices in the same network')}
            ${renderByteArrayField(setting.id, 4, 'Unused (reserved)', bytes[4], null, 'Currently not used')}
        </div>
    `;
}

function renderLp0NodeParams(setting, value) {
    const bytes = parseByteArrayValue(value, setting.length);
    return `
        <input type="hidden" id="new-value-${setting.id}" value="${bytesToHex(bytes)}" />
        <div class="byte-array-grid">
            ${renderByteArrayField(setting.id, 0, 'Offload feature', bytes[0], [
                { value: 0, label: '0 - Offload feature off' },
                { value: 1, label: '1 - Device is a tracker' },
                { value: 2, label: '2 - Device is an offload station' }
            ])}
            ${renderByteArrayField(setting.id, 1, 'Offload station ID', bytes[1])}
            ${renderByteArrayField(setting.id, 2, 'Max overlapping nodes', bytes[2])}
            ${renderByteArrayField(setting.id, 3, 'Use LoRaWAN header for ping', bytes[3], [
                { value: 0, label: '0 - Disabled' },
                { value: 1, label: '1 - Enabled' }
            ], 'Currently unused; pings use LoRaWAN header')}
            ${renderByteArrayField(setting.id, 4, 'Ping interval (seconds)', bytes[4], null, '0-255; 0 = ping ASAP after idle')}
        </div>
    `;
}

function updateLp0ByteArray(settingId) {
    const [_, setting] = getById(settingId);
    const bytes = new Uint8Array(setting.length);
    for (let i = 0; i < setting.length; i++) {
        const input = document.getElementById(`byte-${settingId}-${i}`);
        let value = input ? parseInt(input.value, 10) : 0;
        if (isNaN(value)) {
            value = 0;
        }
        value = Math.min(255, Math.max(0, value));
        if (input && !input.readOnly) {
            input.value = value;
        }
        bytes[i] = value;
    }
    const hiddenField = document.getElementById(`new-value-${settingId}`);
    hiddenField.value = bytesToHex(bytes);
    __onInputChanged(settingId);
}

function updateBitmaskForSetting(settingId) {
    const hiddenField = document.getElementById(`new-value-${settingId}`);
    let bitmask = 0;
    for (const [portName, portNum] of Object.entries(settingsData.ports)) {
        const cbId = `${portName}-${settingId}`;
        const cb = document.getElementById(cbId);
        if (cb && cb.checked) {
            bitmask |= (1 << (portNum - 1));
        }
    }
    hiddenField.value = (bitmask >>> 0).toString();
    __onInputChanged(settingId);
}

// Called when user changes the numeric input for an interval
function updateIntervalValue(settingId) {
    const numericInput = document.getElementById(`interval-num-${settingId}`);
    const unitSelect = document.getElementById(`interval-unit-${settingId}`);
    const hiddenField = document.getElementById(`new-value-${settingId}`);

    let displayVal = parseFloat(numericInput.value) || 0;
    if (displayVal < 0) displayVal = 0; // clamp if needed

    // Convert displayVal from the selected unit -> seconds
    const totalSeconds = convertUnitToSeconds(displayVal, unitSelect.value);

    // Store in hidden
    hiddenField.value = Math.round(totalSeconds).toString();

    __onInputChanged(settingId);
}


// Called when user changes the time unit
function updateIntervalUnit(settingId) {
    const numericInput = document.getElementById(`interval-num-${settingId}`);
    const unitSelect = document.getElementById(`interval-unit-${settingId}`);
    const hiddenField = document.getElementById(`new-value-${settingId}`);

    // Current total seconds in hidden
    let currentSeconds = parseInt(hiddenField.value, 10) || 0;

    // Convert to new unit
    const displayVal = Math.ceil(convertSecondsToUnit(currentSeconds, unitSelect.value));

    numericInput.value = displayVal;

    // Convert displayVal from the selected unit -> seconds
    const totalSeconds = convertUnitToSeconds(displayVal, unitSelect.value);

    // Store in hidden
    hiddenField.value = Math.round(totalSeconds).toString();

    // We keep storing in hidden as seconds
    __onInputChanged(settingId);
}


function toHex(byte) {
    return byte.toString(16).toUpperCase().padStart(2, '0');
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(toHex).join('');
}

function stringToUint8Array(hexString, expectedLength) {
    if (!hexString || typeof hexString !== 'string') {
        return new Uint8Array();
    }
    hexString = hexString.trim();
    if (!/^[0-9A-Fa-f\s]*$/.test(hexString)) {
        throw new Error('Contains non-hex characters.');
    }
    const requiredHexLength = expectedLength * 2;
    if (hexString.length !== requiredHexLength) {
        throw new Error(`Length must be ${requiredHexLength} hex chars for ${expectedLength} bytes`);
    }
    const result = new Uint8Array(expectedLength);
    for (let i = 0; i < expectedLength; i++) {
        const byteStr = hexString.substr(i * 2, 2);
        result[i] = parseInt(byteStr, 16);
    }
    return result;
}

function bytesToSetting(setting, bytes) {
    if (setting.conversion === 'uint32') {
        return new DataView(new Uint8Array(bytes).buffer).getUint32(0, true);
    } else if (setting.conversion === 'uint16') {
        return new DataView(new Uint8Array(bytes).buffer).getUint16(0, true);
    } else if (setting.conversion === 'uint8') {
        return bytes[0];
    } else if (setting.conversion === 'int32') {
        return new DataView(new Uint8Array(bytes).buffer).getInt32(0, true);
    } else if (setting.conversion === 'int8') {
        return new DataView(new Uint8Array(bytes).buffer).getInt8(0);
    } else if (setting.conversion === 'bool') {
        return bytes[0] !== 0;
    } else if (setting.conversion === 'float') {
        return new DataView(new Uint8Array(bytes).buffer).getFloat32(0, true);
    } else if (setting.conversion === 'byte_array') {
        return bytesToHex(bytes);
    } else if (setting.conversion === 'string') {
        return new TextDecoder().decode(new Uint8Array(bytes));
    } else {
        throw new Error(`Unknown conversion type: ${setting.conversion}`);
    }
}

function settingToBytes(setting, value) {
    validateInput(setting, value);

    if (setting.length === 0) {
        return new Uint8Array();
    }

    if (setting.conversion === 'uint32') {
        const intValue = parseInt(value, 10);
        return new Uint8Array(new Uint32Array([intValue]).buffer);
    } else if (setting.conversion === 'uint16') {
        const intValue = parseInt(value, 10);
        return new Uint8Array(new Uint16Array([intValue]).buffer);
    } else if (setting.conversion === 'uint8' || setting.conversion === 'int8') {
        return new Uint8Array([parseInt(value, 10)]);
    } else if (setting.conversion === 'int32') {
        const intValue = parseInt(value, 10);
        return new Uint8Array(new Int32Array([intValue]).buffer);
    } else if (setting.conversion === 'float') {
        return new Uint8Array(new Float32Array([parseFloat(value)]).buffer);
    } else if (setting.conversion === 'bool') {
        return new Uint8Array([value.toString().toLowerCase() === 'true' ? 1 : 0]);
    } else if (setting.conversion === 'byte_array') {
        return stringToUint8Array(value, setting.length);
    } else if (setting.conversion === 'string') {
        return new TextEncoder().encode(value);
    } else {
        throw new Error(`Unknown conversion type: ${setting.conversion}`);
    }
}

function validateInput(setting, value) {
    if (setting.length === 0) {
        return;
    }
    if (['uint32', 'uint16', 'uint8', 'int32', 'int8', 'float'].includes(setting.conversion)) {
        const parsedValue = (setting.conversion === 'float')
            ? parseFloat(value)
            : parseInt(value, 10);
        if (isNaN(parsedValue)) {
            throw new Error(`Must be a number`);
        }

        if (['uint32', 'uint16', 'uint8', 'int32', 'int8'].includes(setting.conversion) && !Number.isInteger(parseFloat(value))) {
            throw new Error(`Must be a whole number`);
        }

        if (setting.min != undefined && setting.max != undefined && (parsedValue < setting.min || parsedValue > setting.max)) {
            throw new Error(`Must be between ${setting.min} and ${setting.max}`);
        }

        // Check min and max values for uint8, uint16, uint32, int8, int32, etc.
        const mm = minMaxValues[setting.conversion];

        if (mm && (parsedValue < mm.min || parsedValue > mm.max)) {
            throw new Error(`Must be between ${mm.min} and ${mm.max}`);
        }
    } else if (setting.conversion === 'bool') {
        const valLower = value.toString().toLowerCase();
        if (valLower !== 'true' && valLower !== 'false') {
            throw new Error(`Must be 'true' or 'false'`);
        }
    } else if (setting.conversion === 'byte_array') {
        stringToUint8Array(value, setting.length);
    } else if (setting.conversion === 'string') {
        if (value.length > setting.length) {
            throw new Error(`Max length is ${setting.length} characters`);
        }
    }
}

let toastTimeout;

function showToast(message) {
    // Clear the previous timer if the button is pressed quickly
    if (toastTimeout) {
        clearTimeout(toastTimeout);
    }

    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.style.opacity = '1';
    toast.style.visibility = 'visible';

    // Hide the toast after 3 seconds
    toastTimeout = setTimeout(() => {
        toast.style.opacity = '0';
        toastTimeout = setTimeout(() => {
            toast.style.visibility = 'hidden';
        }, 500); // Ensure visibility is hidden after fade-out
    }, 3000);
}
