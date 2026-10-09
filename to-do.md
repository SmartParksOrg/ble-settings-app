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
- Service worker cache is currently `app-cache-v44`.

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
8. One-tap Apply (2026-09-26): on hardware, apply a single panel edit and confirm the bar shows
   progress, a toast confirms, and no dialog opens; then apply an edit the device rejects and
   confirm the outcome dialog opens and its Close button is reachable on a phone.

## Firmware v8.0.3 (bundled 2026-10-07, hardware test pending)

Schema identical to v8.0.0/v8.0.1/v8.0.2; DFU bundles for open-collar (15 variants) and
air-quality (4 variants) added. v8.0.3 restores error_ublox in status messages when the GPS
fix retries are exhausted. Verify on SP051307: the app auto-selects settings-v8.0.3.json on a
v8.0.3 device, the built-in DFU list offers 8.0.3 for the device's hardware, the 8.0.3 notes
show, and a DFU from 8.0.2 to 8.0.3 completes with automatic reconnect. After the reconnect the
completion toast and overlay must name the flashed version (fixed 2026-10-09: they said v0.0.0,
the MCUboot header version; the version now comes from the file name). The v8.0.2 DFU bundles
were removed on 2026-10-07 (never verified on hardware); the built-in list now goes 8.0.1 -> 8.0.3.


## Partial raw logs (hardware test pending)

Interrupted log downloads now save what was received (`..._PARTIAL-<n>msgs.txt`), mirror the
capture to IndexedDB, and offer recovery on the next visit. To verify on SP051307:

1. Start "Download all logs", walk out of range (or power the collar off) mid-download: the
   overlay must say "Log download interrupted" and a PARTIAL file must land in Downloads.
2. Same, but close the tab mid-download: reopening the app must show "Interrupted log download
   found" with the message count; "Save partial log" must produce the file.
3. Feed a PARTIAL file to the raw logs decoder; only the last record may be truncated.
4. Retry after reconnecting must download the full set again (device keeps logs until erased).

## iPhone and iPad through Bluefy (added 2026-10-07, hardware test pending)

The app now adapts to iOS WebKit: name-only or accept-all device picker (Bluefy ignores
manufacturerData filters), with-response GATT writes in the DFU client, share sheet or copy
dialog instead of file downloads, a Scan-card notice, Bluefy's setScreenDimEnabled as the DFU
wake lock, and safe-area padding on the bottom bars. Headless checks pass under an iPhone user
agent, but nothing has run on a real iPhone yet. Verify in Bluefy on an iPhone against SP051307:

1. Open the app, tap Scan: the picker opens (all devices, or only SP05* with that prefix typed),
   the collar connects, status and settings load, Apply writes and reads back.
2. Export settings: the share sheet opens; saving to Files produces the JSON. Import the file
   back: zero changes.
3. Download all logs: at the end the save dialog opens; Share saves the file, and the "Save
   file" button in the result overlay reopens it. If sharing files is unavailable, Copy works.
4. DFU to the next release: the upload runs (expect it to be slower than on Android), the
   device reboots and reconnects automatically, and the screen stays awake during the upload.
   If the screen still dims, flip the polarity of setScreenDimEnabled in dfu/dfu.js.
5. Lose the connection on purpose: the Reconnect overlay's picker opens without manufacturer
   data and finds the collar.
