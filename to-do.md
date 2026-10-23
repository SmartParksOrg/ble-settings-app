# DFU Bundled Files - Next Steps

1. Confirm naming alignment between bundled file names and DFU filename parsing in `dfu/dfu.js`. (Done)
2. Decide if we should auto-generate `assets/dfu/manifest.json` from `assets/dfu/releases/` (script or manual). (Done: manifest regenerated from releases)
3. Add device-aware filtering so the bundled selector only shows matching `hwType` + `hwVersion`. (Done, includes v5 migration gating for v6+)
4. Update DFU UI copy if needed (hint text currently says `.bin or .zip` but bundled flow is `.bin`). (Partially done: “bundled” wording updated to “built‑in update”; hint still says `.bin or .zip`)
5. Test service worker caching with offline mode and verify bundled DFU selection works end-to-end. (Done)
6. Treat `rangeredge_airq_nrf52840` as `rangeredge_nrf52840` for DFU selection and file checks. (Done)

Additional changes completed:
- Single source of truth for hardware types and versions via `hardware-types.js`.
- DFU mode hides every card but the DFU ones (one CSS rule on body-level page sections since
  2026-10-23; the earlier id list missed the LP0 offload card); Firmware Notes moved under
  Connected device in DFU mode.
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
4. (Bug fixed 2026-10-20) Exports from 2026-09-25 to 2026-10-20 wrote every enabled boolean as
   false: the device reports booleans as real booleans and the export compared them with the
   string "true". Reported by a user whose fresh export showed unexpected changes on import
   while a months-old export was fine. Exports now use exportSettingValue (Node test), leave
   out settings the device has not sent, and the device values are cleared on disconnect.
   Verify on SP051307: export, import on the same collar -> zero changes, with LED enabled on.
5. Round trip on hardware: export on a v8.0.1 device, import the same file on the same device ->
   zero changes; import a v7.2.0 profile on v8.0.1 -> only settings present in both schemas,
   keyed by name, credentials skipped unless the checkbox is set.
6. (Done in Node) Byte-array, PIN, MAC and coordinate values re-import as equal; every setting in
   both schema generations survives an encode/decode round trip (tests/settings-protocol.test.cjs).
7. (Done) Node tests exist; extend them when export/import code changes.
8. After the guided panels land, re-run the full checklist on hardware: SP051307.
9. One-tap Apply (2026-09-26): on hardware, apply a single panel edit and confirm the bar shows
   progress, a toast confirms, and no dialog opens; then apply an edit the device rejects and
   confirm the outcome dialog opens and its Close button is reachable on a phone.

## Firmware 8.1 development builds, LP0 offload beta (added 2026-10-20, hardware test pending)

The app bundles the 8.1.0 settings schema (branch fix/existing-lp0-implementation, commit
7bae042) and offers the LP0 offload panel, card, Features row and statistics decoding only
when a device reports 8.1. Nothing has run against 8.1 hardware yet; the headless check covers
the UI and the wire bytes. Verify on a manually flashed 8.1 tracker and station:

1. Connect to an 8.1 collar: the app selects settings-v8.1.0.json, the 8.1.0 firmware note
   shows, the LP0 offload panel (beta) and card appear, and an 8.0.3 collar shows neither.
2. In the panel set the station role and ID on the station and the tracker role on the
   tracker, Generate one master key, copy it to the other device (Show, select, copy), apply on
   both: the device reads back the same bytes and the summary names the role and key.
3. Signal checks: switch the master off, apply, read back 00 01 01 64 01 14; a margin of 200
   must be refused by the app before the write.
4. Set the statistics interval to 60 s on the station and tick port 23 under Store in the Data
   matrix; after a few minutes "Show latest 10 stored messages" for LP0 station statistics
   shows decoded rows with the SD card state and counters.
5. Card: Start offload (LP0, unconfirmed, all types) on the tracker with the station in range:
   the reply shows a job ID and discovering or sending, a later start while it runs answers
   busy, Cancel answers cancelled. Start with the satellite medium on a collar without a modem
   answers "satellite modem not detected".
6. Delete confirmed logs (LP0 station) after an offload: the toast confirms and the flash
   message count drops; with a download running it reports that the device did not delete.
7. Export on 8.1, import on the same collar: zero changes, master key included only with the
   credentials box ticked; import an 8.0.3 profile on 8.1: the four new settings are untouched.

## Firmware v8.0.3 (bundled 2026-10-07, hardware test pending)

Schema identical to v8.0.0/v8.0.1/v8.0.2; DFU bundles for open-collar (15 variants) and
air-quality (4 variants) added. v8.0.3 restores error_ublox in status messages when the GPS
fix retries are exhausted. Verify on SP051307: the app auto-selects settings-v8.0.3.json on a
v8.0.3 device, the built-in DFU list offers 8.0.3 for the device's hardware, the 8.0.3 notes
show, and a DFU from 8.0.2 to 8.0.3 completes with automatic reconnect. After the reconnect the
completion toast and overlay must name the flashed version (fixed 2026-10-09: they said v0.0.0,
the MCUboot header version; the version now comes from the file name). The v8.0.2 DFU bundles
were removed on 2026-10-07 (never verified on hardware); the built-in list now goes 8.0.1 -> 8.0.3.


## Automatic time and location on connect (added 2026-10-16, hardware test pending)

Connecting now sends the phone's position and the current time (command 0xAF) as soon as the
first status message arrives; the "Set location & time" button stays for a manual repeat. The
headless check replays a status frame and sees the command, the toast and the status refresh.
Verify on SP051307: connect with location allowed, the toast "Device time and location updated."
appears and the status card shows the current time and the phone's position; connect with
location denied, the toast names the denial and the time is still updated from the last known
position; after a DFU reconnect the update runs again; the button still works.

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

## Join button, Actions export, Settings card (added 2026-10-19, hardware test pending)

The join command is always offered: "Join LoRaWAN" (amber) while the status reports a join
error, "Re-join LoRaWAN" otherwise. The Actions card has an "Export settings" button that
always includes the credentials. The guided panels and their search box now sit inside one
collapsible Settings card. Verify on SP051307: with a join error the amber Join button sends
0xA0 and the status refresh clears the error after a successful join; without an error the
Re-join button sends the same command; Export from Actions produces a JSON with app_key and
device_eui and refuses while edits are pending; the pending chip and the Features card still
jump to a panel field when the Settings card is collapsed.

## Recent stored messages in the Logs card (added 2026-10-20, hardware test pending)

The Recent Status Logs card was folded into the Logs card and generalised: the message type
selector drives "Show latest 10 stored messages" for any port. A headless replay of flash-log
records checks the status table, a short position, a BLE scan and a timestamp message. Verify
on SP051307: latest 10 status messages still render as before; pick "ublox short message" and
confirm the rows show coordinates and the fix time; pick a type with no stored messages and
confirm the "No ... messages found" line; change the type after a load and confirm the old rows
clear; the download of all messages of a type still works from the same selector.

## Device card with the Connect app icons (added 2026-10-20, hardware test pending)

The fixed status bar became a sticky device card above Status with the collar's animal icon
(from the Connect app) and name. Verify on SP051307 (rangeredge): the card shows the ranger
icon and "Ranger · rangeredge v1.8" after the first status message, stays at the top while
scrolling through the panels and turns compact, the pending chip and Disconnect still work
from the stuck card, and the card disappears on the DFU page and after disconnecting.

## Panel changes of 2026-10-20 (hardware test pending)

Data rate picker in the Network panel (DR with SF and bandwidth per region, RP002 tables),
S-Band satellite split out of the Iridium panel, WiFi and BLE scanning split into two panels,
"Tracker search (CMDQ)" renamed to CMDQ, Air quality split out of Sensors, Memfault diagnostics moved to Device and security, every panel folded on mount. Verify on SP051307: with
the Custom ADR profile the data rate list follows the region (EU 868: DR0 = SF12; US 915:
DR0 = SF10) and an applied value reads back; the S-Band panel edits send interval, mode and
frequency and the Iridium panel no longer shows them; a v6 collar shows the S-Band
credentials group; the two scanning panels still hide the old scan settings blocks.

# Ideas for future investigation

## Sequential multi-device DFU (fleet update) over Web Bluetooth (idea, 2026-10-23)

The Android Smart Parks Connect app updates several collars one after another. Tim asked
whether Web Bluetooth allows the same. Assessment:

- Not possible: a scanned list the user ticks several collars in. The browser chooser is the
  only scan in shipping Chrome and Edge and it is single-select; the scanning API that would
  let the app list nearby collars is still behind a flag.
- Possible: collecting the collars with one chooser tap each ("Add collar"), then running the
  whole queue unattended. A chosen device object can be connected to at any time without a
  gesture (the DFU page already reconnects to the rebooted collar this way), and Chrome keeps
  the permission across page reloads and can hand the granted devices back.
- Proposed flow: a Fleet update page with an Add collar button and a queue; optionally a short
  connection per collar to read hardware type and firmware version so the bundled file is
  matched before starting; one Start tap; the runner does connect, PIN, status, upload,
  reset, wait for the swap, reconnect, verify the hash, disconnect, next collar; a results
  table with done, failed and skipped, failures do not stop the queue.
- Constraints: the tab must stay in the foreground on Android (a backgrounded tab loses
  Bluetooth); each collar costs the upload time plus about a minute of swap and reboot; the DFU
  code keeps single-device state in session storage and page variables, which a queue must key
  per device; Bluefy on iOS is uncertain (retained objects likely work within a session,
  persistent permissions probably not), so Chrome and Edge first.
- First step when picked up: a prototype of the Add collar queue plus the sequential runner
  reusing dfu/dfu.js, tested against two collars.
