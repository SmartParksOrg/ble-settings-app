# ble-settings-app
A simple Web Application that uses Web BLE to connect, read and write settings of a OpenCollar Edge device.

Adding a new settings.json version:
- upload settings.json file to settings folder
- add settings.json version to functions.js
- add settings.json version to service-worker.js

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
