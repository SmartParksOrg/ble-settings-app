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
