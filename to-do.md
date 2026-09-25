# DFU Bundled Files - Next Steps

1. Confirm naming alignment between bundled file names and DFU filename parsing in `dfu/dfu.js`. (Done)
2. Decide if we should auto-generate `assets/dfu/manifest.json` from `assets/dfu/releases/` (script or manual). (Done: manifest regenerated from releases)
3. Add device-aware filtering so the bundled selector only shows matching `hwType` + `hwVersion`. (Done, includes v5 migration gating for v6+)
4. Update DFU UI copy if needed (hint text currently says `.bin or .zip` but bundled flow is `.bin`). (Partially done: “bundled” wording updated to “built‑in update”; hint still says `.bin or .zip`)
5. Test service worker caching with offline mode and verify bundled DFU selection works end-to-end. (Done)
6. Treat `rangeredge_airq_nrf52840` as `rangeredge_nrf52840` for DFU selection and file checks. (Done)

Additional changes completed:
- Single source of truth for hardware types and versions via `hardware-types.js`.
- DFU mode hides Logs, Messenger, Status, Actions cards; Firmware Notes moved under Connected device in DFU mode.
- DFU disconnect behavior: block only during active DFU upload; reload after disconnect in DFU mode.

Notes:
- Bundled files live in `assets/dfu/releases/` and the manifest is `assets/dfu/manifest.json`.
- Service worker cache is currently `app-cache-v36`.

Firmware v8 support completed:
- Bundled the official v8.0.0 settings schema.
- Added family-aware settings/value lookup, BLE reads/writes, and HEX composition.
- Preserved legacy firmware support and setting-name-based JSON profiles.
- Updated v8 BLE scan filter choices and added protocol regression tests.
- Physical-device verification remains to be performed on v8 hardware.

# Settings import/export verification (must work perfectly)

Import and export are the way profiles move between devices and firmware versions, so every
settings-UI change must be checked against them. Open items:

1. (Done) Export refuses while changes are pending and exports the values the device reported.
2. (Done) Import refuses while changes are pending and previews against device values.
3. (Done) Import uses the same ordered, write-then-read-back apply path as "Review and apply".
4. Round trip on hardware: export on a v8.0.1 device, import the same file on the same device ->
   zero changes; import a v7.2.0 profile on v8.0.1 -> only settings present in both schemas,
   keyed by name, credentials skipped unless the checkbox is set.
5. (Done in Node) Byte-array, PIN, MAC and coordinate values re-import as equal; every setting in
   both schema generations survives an encode/decode round trip (tests/settings-protocol.test.cjs).
6. (Done) Node tests exist; extend them when export/import code changes.
7. After the guided panels land, re-run the full checklist on hardware: SP051307.

