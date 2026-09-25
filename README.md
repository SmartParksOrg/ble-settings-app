# ble-settings-app
A simple Web Application that uses Web BLE to connect, read and write settings of a OpenCollar Edge device.

## Running locally

This app is a static web app. There is no build step and no `package.json`.

Serve the repository root over a local HTTP server instead of opening `index.html` directly from disk:

```bash
cd /home/tim/apps/ble-settings-app
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/` for the main BLE settings app
- `http://localhost:8000/composer.html` for the HEX composer

Notes:

- Use a Chromium-based browser such as Chrome or Edge, because the app uses Web Bluetooth / Web BLE.
- `localhost` is required here because the app registers a service worker and fetches local JSON assets. Opening the files with a `file://` URL will not work correctly.

Adding a new settings.json version:
- upload settings.json file to settings folder
- add settings.json version to functions.js
- add settings.json version to service-worker.js

## Firmware v8 settings support

The app and HEX composer support both the legacy settings protocol and the family-based
protocol released in OpenCollar v8.0.0. The bundled `settings/settings-v8.0.0.json` is the
unmodified [v8.0.0 release asset](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/releases/tag/v8.0.0),
and `settings/settings-v8.0.1.json` is the unmodified
[v8.0.1 release asset](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/releases/tag/v8.0.1).
The v8.0.1 schema is identical in content to v8.0.0; it is bundled so the app selects the
latest patch release and shows its firmware notes. Bundled DFU releases for v8.0.1 live in
`assets/dfu/releases/open-collar-v8.0.1/` and `assets/dfu/releases/air-quality-v8.0.1/`.

- Legacy settings use `id length data`; v8 settings use `family id length data`.
- Runtime value responses also include a family byte in v8 (currently `0xA0`).
- Commands retain `id length data`. Single-setting (`A8`) and single-value (`A3`)
  requests include `family id` as their two-byte payload in v8.
- Bluetooth and satellite payloads prepend the port; LoRaWAN uses the port separately.
  Values remain little-endian; the address is always sent as family first, then ID.

`functions.js` normalizes family-based settings and values to a unique `0xFFII` address
in memory for DOM IDs and lookups, preserving the original byte ID as `wireId`. Use
`getProtocolAddress`, `encodeProtocolRecord`, and `encodeReadRequest` for wire data;
do not serialize the normalized ID as a single byte. JSON import/export remains keyed
by setting name, so existing profiles can be imported across the protocol change.

Automatic schema selection matches numeric major/minor versions. A manual selection
with the wrong protocol is rejected. Future firmware schemas must still be bundled
when settings change; the family-based format alone does not guarantee compatibility.
The firmware documentation calls the development transition v7.4; v8.0.0 is the
published release that contains it.

Protocol references:
- [Firmware settings documentation](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/blob/v8.0.0/scripts/settings/README.md)
- [Firmware parser and response encoder](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/blob/v8.0.0/app/src/settings/settings_interface.c)

The firmware migrates stored settings itself. Downgrading to older firmware uses the
old storage addresses and can restore defaults; export a settings profile before a
firmware change. Bundled DFU releases are managed separately from settings schemas.

Run the dependency-free regression tests with Node.js:

```bash
node --test tests/settings-protocol.test.cjs tests/mcumgr.test.cjs
```

## DFU flow

DFU runs over MCUmgr SMP on the same GATT connection as the settings UART. After the
image is uploaded and marked for test, the app resets the device and reconnects to the
retained `BluetoothDevice` object automatically; no browser chooser is needed because
`gatt.connect()` does not require a user gesture, only `requestDevice()` does. The app
keeps retrying for up to three minutes while MCUboot swaps the image, then reads the
image state over SMP, checks that slot 0 carries the uploaded hash, and returns to the
device screen. The firmware confirms its own image on boot, so the SMP confirm step is a
safety net rather than a requirement. A screen wake lock is held during upload and
reboot. If automatic reconnect fails, the overlay offers a retry and a manual scan.

Adding a new bundled DFU firmware release:
- upload `.bin` files to `assets/dfu/releases/<release-id>/...`
- add release entries to `assets/dfu/manifest.json` (release id, firmware version, and file paths)
- bump `CACHE_NAME` in `service-worker.js` so clients fetch the new bundle
- add firmware release notes to `device-version-notes.json` if you want notes shown in the UI

App versioning shown in UI:
- the app reads `version.json` and shows it in the header (both `index.html` and `composer.html`)
- update `version.json` on every deployment, preferably from GitHub Actions

Example GitHub Actions step to generate `version.json` on each deploy:
```yaml
- name: Generate app version metadata
  run: |
    if [[ "${GITHUB_REF_TYPE}" == "tag" ]]; then
      APP_VERSION="${GITHUB_REF_NAME}"
    else
      APP_VERSION="dev-${GITHUB_SHA::7}"
    fi
    printf '{\n  "version": "%s",\n  "commit": "%s",\n  "built_at": "%s"\n}\n' \
      "${APP_VERSION}" \
      "${GITHUB_SHA}" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > version.json
```
