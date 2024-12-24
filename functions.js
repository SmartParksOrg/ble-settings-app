let settingsData = null;
let settingsMap = new Map(); // maps int ID -> [key, meta]

const intervalPatterns = [
    /_interval_?\d?$/,        // matches _interval, _interval1, _interval2, etc.
    /rf_scan_duration$/     // matches strings ending with rf_scan_duration
];

const bitmapSettings = ['lr_send_flag', 'flash_store_flag', 'sat_send_flag'];

const skipPorts = ['port_lr_messaging', 'port_flash_log', 'port_values', 'port_messages', 'port_commands'];

async function loadSettings(selectedFile) {
    settingsData = null;
    settingsMap = new Map();

    try {
        const response = await fetch(selectedFile);
        settingsData = await response.json();

        settingsMap = new Map();
        registerValues(settingsData.settings);
    } catch (error) {
        throw new Errow(`Error loading settings: ${error.message}`);
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

function getInputValue(settingId) {
    return document.getElementById(`new-value-${settingId}`).value.trim();
}

function registerValues(data) {
    for (const [key, value] of Object.entries(data)) {
        // key is the string name of the setting
        // value includes: id, default, min, max, conversion, etc.
        settingsMap.set(parseInt(value.id, 16), [key, value]);
    }
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
    return bitmapSettings.includes(key);
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

        const bitIsSet = (defaultVal & (1 << portNum)) !== 0;
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

function groupAndSortSettings() {
    const grouped = {};
    const other = {};

    for (const key in settingsData.settings) {
        const prefix = key.split('_')[0];
        if (!grouped[prefix]) {
            grouped[prefix] = {};
        }
        grouped[prefix][key] = settingsData.settings[key];
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

    // Sort groups
    const sortedGroups = Object.keys(grouped).sort().reduce((acc, group) => {
        acc[group] = Object.keys(grouped[group]).sort().reduce((groupAcc, key) => {
            groupAcc[key] = grouped[group][key];
            return groupAcc;
        }, {});
        return acc;
    }, {});

    return sortedGroups;
}

function renderInput(key, setting) {
    return `<div class="input-container" id="input-container-${setting.id}">${renderInputControl(key, setting, setting.default)}</div>`;
}

function renderInputControl(key, setting, value) {
    // Build the "include" checkbox + label
    let html = '';

    // 1) If it's one of the three bitmask settings -> render port checkboxes
    if (isBitmaskSetting(key) && setting.conversion === 'uint32') {
        html += renderPortCheckboxes(setting, value);
    }

    // 2) If the key ends with "_interval" -> render numeric + time-unit select (with auto-guess)
    else if (intervalPatterns.some(rx => rx.test(key)) && setting.conversion === 'uint32') {
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
        html += `<input
         type="number"
         id="new-value-${setting.id}"
         min="${setting.min}"
         max="${setting.max}"
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

function updateBitmaskForSetting(settingId) {
    const hiddenField = document.getElementById(`new-value-${settingId}`);
    let bitmask = 0;
    for (const [portName, portNum] of Object.entries(settingsData.ports)) {
        const cbId = `${portName}-${settingId}`;
        const cb = document.getElementById(cbId);
        if (cb && cb.checked) {
            bitmask |= (1 << portNum);
        }
    }
    hiddenField.value = bitmask.toString();
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
        return new Uint8Array([value.toLowerCase() === 'true' ? 1 : 0]);
    } else if (setting.conversion === 'byte_array') {
        return stringToUint8Array(value, setting.length);
    } else if (settingObj.conversion === 'string') {
        return new TextEncoder().encode(value);
    } else {
        throw new Error(`Unknown conversion type: ${setting.conversion}`);
    }
}

function validateInput(setting, value) {
    if (['uint32', 'uint16', 'uint8', 'int32', 'int8', 'float'].includes(setting.conversion)) {
        const parsedValue = (setting.conversion === 'float')
            ? parseFloat(value)
            : parseInt(value, 10);
        if (isNaN(parsedValue) || parsedValue < setting.min || parsedValue > setting.max) {
            throw new Error(`Must be between ${setting.min} and ${setting.max}`);
        }
    } else if (setting.conversion === 'bool') {
        const valLower = value.toString().toLowerCase();
        if (valLower !== 'true' && valLower !== 'false') {
            throw new Error(`Must be 'true' or 'false'`);
        }
    } else if (setting.conversion === 'byte_array') {
        stringToUint8Array(value, setting.length);
    }
}