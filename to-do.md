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
- The deploy stamps the service worker cache name with the commit (`app-cache-<sha>`).

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

## Offline first (added 2026-10-28, field test pending)

Tim reported that the app took very long to open offline or on a bad connection in Namibia.
Cause: the service worker was network first and only used the cache when the network failed,
so a slow link that still delivered bytes was waited on for every file; a version change also
wiped the cache (DFU binaries included) after every deploy. The worker is now cache first, a
deploy is a new worker (the workflow stamps the commit into CACHE_NAME), DFU binaries are
carried over between workers and filled one by one in the background. Node and headless checks
pass; verify in the field, on a phone that has opened the app online once:

1. Flight mode, open the app: it opens within a few seconds, the version badge shows a
   version, a collar connects and its settings load; the DFU page lists the built-in updates
   and a DFU runs from the cached binary.
2. On a 2G or congested link: the same, no slower than in flight mode; the map tiles may stay
   blank, nothing else waits for them.
3. After a deploy, open the app on a good link: it reloads once by itself (not while a collar
   is connected; then a toast announces the reload), the badge names the new version, and the
   Debug log line "Built-in DFU files available offline: n of n" is complete without a long
   download.
4. Open the app on a good link right after a deploy and switch the link off while the new
   worker is still installing: the old version keeps opening until the install completes.
5. On the MTC network (where updates only arrived over a VPN): tap the version line in the
   footer. "Up to date" or "Update found" means the network is fine and the old install (which
   waited for 34 MB of DFU binaries) was the cause; "Update check failed: ..." names what MTC
   does to the connection. Note the text; a QUIC block is one candidate (test with QUIC off
   under chrome://flags).

## Firmware 8.2.0 pre-release, LP0 offload and transfers by delivery state (beta; added 2026-10-20, updated 2026-11-06, hardware test pending)

The app bundles the 8.2.0 settings schema (branch fix/existing-lp0-implementation, commit
4b58e4f of 2026-11-04; it replaced the 8.1.0 snapshot) and offers the LP0 offload panel, card,
Features row, statistics decoding and the "new logs" download only when a device reports 8.1 or
newer. Nothing has run against this firmware yet; the headless check covers the UI and the wire
bytes. Before the test, check what version the test build reports: the firmware's VERSION comes
from `git describe`, so a branch build without a v8.2.0 tag reports 8.0.3 and the app hides every
beta feature (ask the firmware team to build with `version.py --tag v8.2.0-0` or similar). Open
questions for the firmware team, found while reading the source on 2026-11-06:

- No count of confirmed or unconfirmed records exists yet (flash_nr_msg and the port-14 flash
  status carry the total). The firmware developer is adding the confirmed and unconfirmed counts
  to the port-14 flash status message (Tim, 2026-11-06). When the layout is known (per medium or
  Bluetooth only, field widths, message length; the message is `94 len % used, total u32`
  today and the app does not decode it at all): request it with cmd_get_flash_status (`20 B3 00`)
  on connect, after a download and after an erase (the message decodes since 2026-11-06,
  decodeFlashStatusMessage in functions.js); show "n not yet downloaded over Bluetooth"
  next to the Flash messages count in the Logs card; use that number as the known total of a
  "Download new logs" progress bar; and decode it in the Logs card's recent messages as well.
  Bump the schema snapshot if the message length changes.
- No job state query exists; the app uses a cancel with job ID 0xFFFFFFFF, which the firmware
  refuses with ESTALE while answering with the current job's fields (offload_job_cancel in
  offload_job.c). A proper query, or a closing cmd_confirm after an explicit Bluetooth transfer,
  would remove the 3-second silence detection.
- cmd_recover_sd answers nothing when accepted (prv_execute_command_message returns 0); a
  cmd_confirm 1 would let the app say "started" instead of waiting for the fresh report.

Verify on a manually flashed 8.2.0 tracker and station:

1. Connect to an 8.2 collar: the app selects settings-v8.2.0.json, the 8.2.0 firmware note
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
7. Export on 8.2, import on the same collar: zero changes, master key included only with the
   credentials box ticked; import an 8.0.3 profile on 8.2: the eight new settings are untouched.
8. Schema of 2026-10-27: on the station turn on "GPS fix before offloading" in the LP0 panel,
   apply, read back true; after the next offload the station's timestamps and SD file times are
   current. Switch LoRaWAN off in the Network panel only on a bench collar and note what the
   firmware does, so the help text can say it; same for "Fix requires valid time" in Positioning.
9. (First run 2026-11-06 on SP051307: the device streamed at once and answered the start with
   job 2, waiting, -119; the app read -119 with Linux errno numbers as a failure and aborted after
   72 records while the stream went on. Fixed the same day: the table now uses newlib's numbers,
   -119 = EINPROGRESS. The second run at 14:56 returned 1 record, correctly: the aborted stream
   had delivered the whole backlog, which the device counts as delivered. Since then the app
   cancels a transfer it gives up on. Repeat the test after new records have been stored.)
   Download new logs (Logs card, checkbox on by default): on a collar with stored records the
   download starts (Debug log: "Bluetooth transfer job n sending"), the records arrive, after
   the stream ends the probe `20 D1 04 FF FF FF FF` is answered with state done and the file
   raw_logs-new-... is saved; run it again at once: "No new logs". Then "Download all logs"
   with the checkbox off still delivers everything. Note how long the silence before the probe
   is in practice; 3 s is a guess, lengthen OFFLOAD_DOWNLOAD_SILENCE_MS in index.html if the
   device pauses longer between packets (a pause ends a download early as "done" only if the
   device really reports done, otherwise the probe is repeated, so a too-short value costs only
   extra probes). Cancel mid-way: the device stops streaming. Walk out of range mid-way, come
   back, Retry: only the remaining records arrive.
10. Refresh state in the LP0 card while an automatic offload runs on a tracker: state and
   confirmed count follow the offload; while idle it says what the last job did. Confirm that the
   probe never cancels a running automatic offload (the station keeps receiving).
11. Station status (LP0 card, station role): "Load latest report" shows the stored report with
   the SD card present and writable; pull the card, wait for the magenta flashes, load again:
   "missing" and the storage fault; reinsert, "Check SD card": within 15 s the fresh report shows
   the card present again and the toast "Fresh station report received". On a tracker the block is
   hidden and Check SD card is refused.
12. Discovery retries: set 2 on a tracker, apply, read back 2; the LP0 summary names it. The
   signal checks default reads 1 1 1 100 0 20 in the All settings list after a factory reset.

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

### Collar listed as "Zephyr" on iPhone (reported 2026-11-11)

Apple users see a long Zephyr name instead of the SP name in Bluefy's picker, not always (firmware issue #773). Cause:
iOS shows the GATT Device Name it cached at an earlier connection; the firmware advertises the
SP name but leaves the Device Name characteristic at Zephyr's build default (no
`CONFIG_BT_DEVICE_NAME`, no `bt_set_name` in `app/src/bt_module/bt_adv/bt_adv.c`). Ask the
firmware team to set `CONFIG_BT_DEVICE_NAME_DYNAMIC=y` (`CONFIG_BT_DEVICE_NAME_MAX` of at least 8)
and call `bt_set_name(device_name)` in `ble_adv_device_name_update`, for the default "SP" + MAC
name as well. The app side (device card and log file names from `device_name`, a hint in the
Scan notice) shipped 2026-11-11. Verify on an iPhone: connect once, scan again and note the exact
name Bluefy lists; after connecting, the device card shows the SP name. With the firmware fix:
connect once, and the next scan lists the SP name.

## Join button, Actions export, Settings card (added 2026-10-19, hardware test pending)

The join command is always offered: "Join LoRaWAN" (amber) while the status reports a join
error, "Re-join LoRaWAN" otherwise. The Actions card has an "Export settings" button that
always includes the credentials. The guided panels and their search box now sit inside one
collapsible Settings card. Verify on SP051307: with a join error the amber Join button sends
0xA0 and the status refresh clears the error after a successful join; without an error the
Re-join button sends the same command; Export from Actions produces a JSON with app_key and
device_eui and refuses while edits are pending; the pending chip and the Features card still
jump to a panel field when the Settings card is collapsed.

## Satellite modem state and send buffer (2026-11-11, hardware test pending)

"Send satellite buffer now" sends `20 C6 00` and is shown only while the collar reports
`satellite_enabled` on and its modem detected. Verify on a FreeEdge with a RockBLOCK (the Connect
app says "not available" on it while satellite is off):

1. Satellite off: the Status card and the Iridium panel say "not tested", Actions shows neither
   satellite button.
2. Switch Satellite sending on and apply: the modem line says "testing…", and within about 15 s
   the toast "Satellite modem detected" appears (Debug log: status requests `20 A4 00`, the last
   byte of the status line has bit 0 set). Note how long the collar takes; the polls run at 12,
   25 and 45 s (`SATELLITE_MODEM_CHECK_DELAYS_MS`).
3. Tap "Send satellite buffer now": the toast says the send started, the button is disabled for
   30 s, and the messages (or a status message with an empty queue) arrive in the satellite
   backend. Afterwards the panel names the attempts of the last send. Note how long the send takes.
4. Unplug the RockBLOCK, restart the collar with satellite on: "not found" and "Test satellite
   modem"; plug it back in and tap the test: "detected".
5. On a CollarEdge: no modem line in the Status card, the panel says the type has no modem port.

## DFU reconnect on Chrome for macOS, Actions import, LoRaWAN feature row (2026-11-12, hardware test pending)

Tim reported that the automatic reconnect after a DFU does not work in Chrome on a Mac. Likely
cause, not yet confirmed on a Mac: `gatt.connect()` without a timeout (see README, DFU flow).
Each attempt is now cut off after 20 s and retried, and "Scan for device" appears after a minute.
Verify on a Mac with Chrome against SP051307:

1. DFU to the next release and watch the overlay: the attempt counter keeps going up (Debug
   log: "Auto reconnect attempt n failed: no answer within 20 s" while the collar swaps), and
   the collar reconnects by itself once it advertises again. Note after how many seconds.
2. If it still does not reconnect: after a minute tap "Scan for device", pick the collar (it may
   be listed as "Zephyr..."), and the verify step runs. Send the Debug log either way, so we
   can see whether the attempts fail fast, time out, or connect but fail on the SMP service
   (a cached GATT table on macOS would show as a service error after a connect).
3. Actions card: Import settings opens the file picker and the preview; with the credentials
   box under All settings unticked, the preview says credentials are skipped.
4. Features card: the LoRaWAN row shows the collar's region, data rate (Custom ADR) or ADR
   profile, status and rejoin intervals; it changes with an edit in the Network panel.

## Feature settings editable while the feature is off (2026-11-11, hardware test pending)

Panels no longer grey out a feature's settings while its switch is off (see README, Guided
settings). Verify on SP051307: with CMDQ off, set the searched MAC and the intervals, apply, read
back, CMDQ still off; then switch CMDQ on and apply: it is written last. Same for the fence
interval with fencing off, and the Iridium day and night schedule with satellite sending off.

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
