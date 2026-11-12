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
- The service worker serves the app from its cache first (see "Offline use" below), so an
  edited file does not show on a plain reload. While developing, tick "Bypass for network" (or
  "Update on reload") under Application > Service workers in DevTools, or bump `CACHE_NAME` in
  `service-worker.js`. The browser harness starts from a fresh profile and needs nothing.

Adding a new settings.json version:
- upload settings.json file to settings folder
- add settings.json version to functions.js (`SETTINGS_FILES`, newest first); a development
  snapshot also goes into `BETA_SETTINGS_FILES`, which lists it in a "Beta" group at the bottom
  of the schema dropdown on both pages, so a release stays the first choice and the composer's
  default (the firmware match still picks the snapshot for a collar that reports its version)
- add settings.json version to service-worker.js (`STATIC_FILES`); the deploy stamps
  `CACHE_NAME` with the commit, bump it by hand only to see the change locally
- update the expected file in `tests/settings-protocol.test.cjs` ("schema selection")
- add firmware release notes to `device-version-notes.json` if you want notes shown in the UI

## Offline use

The app has to open and work with no internet or a bad connection (2G in the field), and a bad
connection must never make it slower than no connection. Since 2026-10-28 the service worker is
cache first: every app file (pages, scripts, styles, schemas, settings metadata, firmware
notes, version.json, DFU manifest, the map library) is answered from the cache at once, and the
network is only asked for a file that is not cached yet. Until then the worker was network
first and only fell back to the cache when the network *failed*; a slow link that still
delivered bytes was waited on for every one of the roughly 0.8 MB a page open needs. Map tiles
are the only online-only content and are never cached.

Updates travel through the worker, not through the pages: the deploy workflow stamps the
commit into `CACHE_NAME`, so each deploy is a new worker. The browser installs it in the
background (every app file fetched fresh, bypassing the HTTP cache), the main page tells it to
take over and reloads once it has, unless a collar is connected, a DFU runs or edits are
pending, in which case the reload waits. The composer picks the new version up on its next
open. version.json is served from the same cache as the code, so the version badge always names
the running version; it is no longer used to trigger a reload, and the old "clear every cache
and reload on a version change" is gone: it threw away the DFU binaries after every deploy.

The 34 MB of built-in DFU binaries are not part of the install. On install the new worker
copies the binaries the previous cache already holds (their paths carry the firmware version,
so a cached copy is never stale), and the pages ask the worker (`PRECACHE_DFU`) to fetch the
missing ones one by one in the background, on every open and whenever the browser comes back
online. A failed download costs one file and the next request resumes; a deploy downloads no
binary twice. The worker reports the count to the pages (`DFU_CACHE_STATUS`, shown in the
console and kept in `window.dfuCacheStatus`). The header spinner only covers the files the
settings UI needs: `initSwCacheIndicator` in `functions.js` fetches missing ones one at a time
with a backoff and gives up after five attempts, so it cannot spin forever.

The page stays as it is: no update status is shown. Every open checks for a new worker
silently and writes the outcome to the Debug log ("Update check: up to date", "new version
found, installing", or "Update check failed: ..."), next to the count of built-in DFU files
cached offline. A tap on the version line in the footer runs the check again and answers with
a toast, so a check that fails on a particular mobile network, which is why an update never
arrived there, can be seen on request. When an update has installed while a collar is
connected, one toast says the app reloads after the disconnect. The install fetches a few
files at a time and retries each up to three times, so one dropped request on a lossy link
does not fail the whole install; a file that keeps failing does, and the previous worker keeps
serving until the next open tries again.

`tests/service-worker.test.cjs` runs the worker in Node against an in-memory cache: cache first
without touching the network, fresh app files per install, DFU binaries carried over and filled
one at a time, the cache-name pattern the deploy stamps. The browser harness has an offline
scenario with a server of its own: a cached app must open within three seconds while the link
hangs and while it is down, schemas, notes and a DFU file must load from the cache, and a
simulated deploy must install the new worker without downloading a binary.

## Using the app on an iPhone or iPad

Safari, Chrome and every other browser on iOS cannot talk to Bluetooth devices, so the app
does not work in them. Use the free Bluefy app instead; it is a web browser with Bluetooth
support.

1. Install **Bluefy – Web BLE Browser** from the App Store:
   https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055
2. Open Bluefy and enter the app address in its address bar:
   https://smartparksorg.github.io/ble-settings-app/
   (opening the address in Safari shows a notice with a link to Bluefy instead of a Scan that works).
3. Turn on Bluetooth on the phone and allow Bluefy to use it when iOS asks.
4. Tap **Scan**. The list shows every Bluetooth device nearby, not only collars. To shorten it,
   open **Scan settings** first and type the start of the collar name, for example `SP05`.
5. Pick the collar. From here the app works as on Android: settings, panels, logs and DFU.

Things that work differently on an iPhone:

- **Export settings** and **Save partial log** open the iOS share sheet instead of downloading a
  file. Choose **Save to Files** (or Notes, Mail, AirDrop). If the share sheet does not appear,
  a dialog shows the file contents with a **Copy** button; paste them into Notes.
- A finished **Download all logs** shows the same dialog, and the result box keeps a
  **Save file** button to reopen it.
- **Import settings** uses the iOS file picker; pick the JSON you saved to Files earlier.
- **DFU** is slower than on Android (each packet waits for a reply). Keep Bluefy in the
  foreground until the collar has rebooted and reconnected.
- Bluefy does not install the app on the home screen or keep an offline copy; it needs an
  internet connection to load the page.
- A collar the iPhone has connected to before can be listed as "Zephyr" instead of its SP name,
  and then a typed name does not find it. Clear the name in Scan settings and pick the Zephyr
  entry; once connected, the app shows the collar's real name.

If something does not work, tap the floating **Debug** button that appears while a collar is
connected and send the log along with the iPhone model, iOS version and Bluefy version
(Bluefy settings show it).

## Browser support details

The app needs Web Bluetooth: Chrome or Edge on Windows, Android, macOS and Linux, and
[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) on iOS, a WebKit
browser with its own Web Bluetooth stack. The app detects iOS WebKit (and a missing
`navigator.bluetooth`) and adapts; nothing changes for Chrome and Edge:

- The Scan card shows a notice: a link to Bluefy when Web Bluetooth is missing on iOS, a hint
  to use Chrome or Edge elsewhere, and on Bluefy an explanation that the picker lists every
  nearby device. Scan without Web Bluetooth shows a toast instead of throwing.
- Bluefy ignores `manufacturerData` scan filters (a filter carrying one matches nothing), so on
  iOS the picker is opened with the typed name prefixes only, or with `acceptAllDevices`. Other
  browsers keep the manufacturer filter; a `TypeError` from an unsupported filter shape retries
  the same relaxed way, and a cancelled picker is never reopened (`requestUartDevice`).
- Bluefy has no `writeValueWithoutResponse`. The main page already preferred with-response
  writes; `dfu/mcumgr.js` now falls back to `writeValueWithResponse` and then `writeValue`, so
  DFU works there too (slower, one round trip per SMP packet; the usual MTU step-down applies).
- iOS cannot download a Blob through an anchor. `saveTextFileCompat` in `functions.js` keeps the
  download on other platforms; on iOS it opens the share sheet when called from a tap (export,
  save partial log) and otherwise a dialog with the file contents, a Share button (when the
  browser can share files) and a Copy button. A finished log download shows a "Save file"
  button in the result overlay so the share sheet can be opened from a tap.
- The DFU wake lock falls back to Bluefy's `bluetooth.setScreenDimEnabled(false)` where the
  Wake Lock API is missing.
- iOS names a device after the GATT Device Name it read at an earlier connection, not after the
  advertised name. The firmware only puts the collar name ("SP..." or the `device_name` setting)
  in the advertising packet (`bt_adv.c`) and never calls `bt_set_name`, so the Device Name
  characteristic keeps Zephyr's build default, and a collar the phone has met before shows
  under that name in Bluefy's picker and in `device.name`. The picker is Bluefy's own and cannot
  be changed from the page. The app shows the `device_name` setting in the device card and uses
  it in log file names once the collar reports it (`getCollarDisplayName`); reconnects still
  match on `device.name`, which is what `getDevices()` returns. The fix belongs in the firmware:
  `CONFIG_BT_DEVICE_NAME_DYNAMIC=y` and a `bt_set_name()` call in `ble_adv_device_name_update`,
  after which iOS picks up the SP name at the next connection (see to-do.md).
- `viewport-fit=cover` plus `env(safe-area-inset-bottom)` padding keep the pending-changes bar
  and the bottom bars above the iPhone home indicator.

`tests/browser-input-check.mjs ... ios` emulates an iPhone running Bluefy (user agent, touch,
stubbed device picker, stubbed downloads) and checks these paths; the desktop and mobile runs
check that exports still download through an anchor and that the manufacturer filter stays.
Verification on a real iPhone with Bluefy is still open (see to-do.md).

## Firmware 8.2.0 pre-release: LP0 offload and transfers by delivery state (beta)

The next firmware release, 8.2.0, is being finished on the `fix/existing-lp0-implementation`
branch of the private firmware repository (PR #769) and is still flashed by hand; the app
bundles no DFU file for it. Its settings schema, `settings/settings-v8.2.0.json`, is the branch's
`scripts/settings/settings.json` at commit 4b58e4f (2026-11-04), bundled in the "Beta" group of
the schema dropdown; replace the file with the release asset once v8.2.0 is published. It
replaced the earlier `settings-v8.1.0.json` snapshot (the development line was first called 8.1):
the schema differs from that snapshot in one added setting, `lp0_discovery_retry_count`, and the
default of `lp0_signal_checks` (background margin check off). Against 8.0.3 it adds eight
settings (`lp0_master_key`, `lp0_signal_checks`, `lp0_focus_offloading`,
`lp0_statistics_interval`, `lp0_gps_before_start`, `lp0_discovery_retry_count`, `lr_enabled`,
`ublox_require_time`), four commands (`cmd_offload_start` 0xCF, `cmd_offload_cancel` 0xD1,
`cmd_flash_clear_confirmed` 0xD2, `cmd_recover_sd` 0xD3), the station statistics message
(port 23, id 0x9D) and new defaults for `flash_store_flag` and `lp0_send_flag` (port 23 set).

The firmware version a device reports decides what the app offers: the schema match needs 8.2
(`findSettingsFileForFirmware` matches major.minor), and the LP0 panel, the LP0 card and the
"new logs" download appear from 8.1 on. The firmware's `VERSION` file comes from `git describe`,
so a build of the branch without a `v8.2.0` tag reports the nearest tag, 8.0.3, and the app then
treats it as 8.0.3 (no beta features); build with a tag or pick the 8.2.0 schema by hand and
accept that the LP0 features stay hidden until the status says 8.1 or newer.

### Records remember how they were delivered

Since this firmware every saved record carries a flags byte with one bit per medium (satellite,
Bluetooth, LoRaWAN, LP0 station); a medium clears its bit once it has confirmed the record.
`cmd_offload_start` (`20 CF 03 medium selection port`) sends the records that are still
unconfirmed (or confirmed, or all) over a medium: LP0 0, LoRaWAN 1, satellite 2, Bluetooth 3,
optionally filtered to one application port. Bluetooth transfers stream the records on port 29
exactly like `flash_get_all`, but **the firmware sends no closing message for them** (only the
legacy `flash_get_all` ends with `cmd_confirm`); the 19-byte job reply answers the start and
cancel commands only. There is no command that counts confirmed or unconfirmed records
(`flash_nr_msg` and the port-14 flash status carry the total only), and no job state query; the
first boot of this firmware clears every stored log because of the new record format.

- **Download new logs** (Logs card, firmware 8.1 or newer): a checkbox "Only records not yet
  downloaded over Bluetooth", on by default, turns "Download all logs" into "Download new logs"
  and "Download all messages of this type" into its "new" variant. The app sends
  `20 CF 03 03 02 port`, treats the job reply as the go-ahead (or shows the firmware's reason,
  such as busy or no connection), collects the port-29 packets as before, and after 3 seconds of
  silence asks for the job state. That query is `20 D1 04 FF FF FF FF`: a cancel naming a job ID
  that cannot exist, which the firmware refuses with ESTALE while still answering with the
  current job's state and confirmed count, and which cancels nothing (`offload_job_cancel` in
  the firmware source; the firmware documentation says there is no state query, so this is a
  source-verified workaround, see to-do.md). The errno in the reply uses newlib's numbering
  (the firmware builds with `CONFIG_NEWLIB_LIBC`): EINPROGRESS is -119, ESTALE -133, ECANCELED
  -140, ENOTSUP -134, ENOTCONN -128, ENETDOWN -115; `OFFLOAD_ERRNO` in `functions.js` holds the
  table. Until 2026-11-06 the app used Linux's numbers and read a started transfer (-119) as a
  failure, which aborted the first field test on SP051307 one second into a running stream. "done" completes the download, "failed" interrupts
  it, a job still sending is probed again (up to 30 seconds without data). An empty transfer
  ends as "Nothing new to download". A start the collar refuses with EBUSY is asked again up
  to four times, four seconds apart, with the reason shown meanwhile: a tracker's automatic
  discovery attempt owns the job slot for a few seconds every discovery interval, a flash read
  (tracks, recent messages) owns the flash while it runs, and a cancelled transfer settles its
  confirmations first. Cancel sends the real cancel for the job; Retry asks again for the
  records still unconfirmed, so a partial download continues where it stopped. The file is
  `raw_logs-new-<device>_<timestamp>.txt`. The completion dialog (and the interruption dialog,
  for what was saved) reports the download: records, packets and bytes, duration, the storage
  time span by the device clock, a count per message type, and for a new-logs download what
  the device confirmed as delivered. "Erase all logs" is offered only after the legacy download of
  everything: a download by delivery state leaves the records on the device on purpose, and
  its cleanup is "Delete confirmed logs" in the LP0 card. With the checkbox off, or on older firmware, the
  legacy `flash_get_all` download runs unchanged. The device marks a record as delivered when
  the notification carrying it completed, not when the app saved the file; records downloaded
  with older firmware or by other means are not marked. The reverse holds too: a transfer the
  app stops collecting keeps streaming and keeps marking records delivered, so whenever the app
  gives up on a transfer while still connected it sends the cancel for that job (on 2026-11-06
  an aborted run delivered the whole backlog of SP051307 into the void; those records stay
  available through "Download all logs").
- **Refresh state** in the LP0 offload card sends the same probe and renders the current or
  last job, automatic offloads included (job 0): state, medium, selection, port, discovery
  attempts and confirmed records. The result line is left out because the probe's reply carries
  ESTALE instead of the job's result.
- **Delete confirmed logs** (LP0 card, `20 D2 01 selector`) erases whole sectors from the oldest
  logs onward while every record in them is confirmed over the chosen medium.
- **Offload station status** (LP0 card, shown when the device reports the station role): the
  station writes a statistics report (port 23, version 3, 104 bytes) every
  `lp0_statistics_interval`, on media changes and after an SD card check, through its normal
  routes: stored in flash when port 23 is in `flash_store_flag` (the new default) and sent over
  LP0 when it is in `lp0_send_flag`. There is no direct Bluetooth reply with it, so the app reads
  the newest stored one with `flash_get_from_head` (port 23, start 0, count 1) and shows it as
  rows: SD card (present and writable, missing, storage fault, write not yet verified), SD reader,
  LP0 radio (listening, visit in progress, radio fault), uptime, tracker visits, records saved,
  SD space, storage errors and report counters, with the storage time by the device clock.
  Unknown flags are shown as unknown. "Check SD card" sends `20 D3 00` (`cmd_recover_sd`): a
  healthy station only writes a fresh report, a station with a failed card runs its recovery test
  and is allowed ten new reader resets. The firmware sends **no reply when it accepts** this
  command (only a refusal is answered with `cmd_confirm 0`), so the app fetches the newest stored
  report a few times until one with a higher uptime or a later storage time appears.

The 2026-10-28 and 2026-11-03 schema changes: `lp0_discovery_retry_count` ("Discovery retries"
in the LP0 panel, trackers only) allows up to 255 extra automatic discovery attempts per
discovery interval after a failed attempt, 0 by default; the LP0 summary names it when set. The
default of `lp0_signal_checks` became `1 1 1 100 0 20`: the background margin check is off, its
20 dB threshold stays stored. The panel help, the list renderer and the metadata say so.

The 2026-10-27 additions: `lp0_gps_before_start` is a toggle in the LP0 offload panel ("GPS fix
before offloading"): a station takes a u-blox GPS fix before an offload session so its clock is
set from the receiver. Its summary sentence is "GPS fix before offloading." `lr_enabled` is the
first field of the Network panel, a master switch for the LoRaWAN stack that warns while off,
and `ublox_require_time` sits in the Positioning panel's "Fix result and follow-up" group; the
firmware documentation does not describe either yet, so their help says only that. The LP0
offload card got a "Recover SD card" button (`20 D3 00`), since 2026-11-06 the "Check SD card"
button of the station status block described above.

The eight LP0 settings that older schemas already have stay where they were: in the LP0 group
of the All settings list and as the LP0 column of the Data sending and storing matrix. The
LP0 features below are only offered when the device reports firmware 8.1 or newer and the
loaded schema carries the master key and the offload commands; they are hidden on 8.0.x, also
when someone picks the 8.2.0 schema by hand for an 8.0 collar. The composer shows the panel
whenever the 8.2.0 schema is selected; the schema sits in the "Beta" group at the bottom of
the dropdown and the composer opens with the latest release instead.

- **LP0 offload panel** (beta tag, between S-Band and VHF): role, station ID, station count and
  discovery interval are the bytes of `lp0_node_params`, edited one byte at a time through
  the new `byte` panel control (`{ key, byte: n, options | min, max }`) and gated with byte
  conditions (`{ key, byte: 0, equals: 2 }`). The cluster master key is a secret hex field with
  a Generate button (`crypto.getRandomValues`), a copy button, and a warning while it is the all-zero
  default.
  Focus on offloading, the statistics interval (station only, warns under 60 s), the radio
  group (frequencies, spreading factor, bandwidth, coding rate, listen window, channel span),
  the six signal-check bytes (CAD, minimum RSSI entered as a positive magnitude, background
  margin, each gated by the master switch) and the device payload keys (device address, app
  key and network key, each with the same copy button as the master key, so they can be
  recorded in the backend) follow. The send mask stays in the Data matrix so no key has two
  editing paths. The panel summary reads
  "Offload station, ID 3 of 10 slots. Cluster master key set. Statistics every 1 hour."
- **Features card** gets an "LP0 offload" row (Tracker / Station, ID n / Off) that jumps to
  the role field.
- **LP0 offload card** (after FenceEdge): Start offload sends `20 CF 03 medium selection port`
  (LP0, LoRaWAN or satellite; unconfirmed, all or confirmed records; one message type or all),
  Cancel sends `20 D1 04 00 00 00 00` (job 0 stops whatever runs), and the device's 19-byte
  reply on the commands port is decoded (`decodeOffloadJobReply` in `functions.js`: job ID,
  state, medium, selection, port, discovery attempts, errno with its documented meaning,
  confirmed records) into the card and a toast. The firmware has no status query, so the card
  shows the last reply, and "Refresh state" asks for the current one (see above). "Delete
  confirmed logs" asks first, then sends `20 D2 01 selector` (any medium, LP0 station, LoRaWAN,
  Bluetooth or satellite); the usual cmd_confirm reply shows a toast and refreshes the flash
  message count. The Bluetooth medium is not offered here: the Logs card's "Download new logs"
  is that transfer.
- **Station statistics** stored in flash (port 23) are decoded in the Logs card's recent
  messages (`decodeLp0StatisticsMessage`, versions 1 to 3): a one-line summary with uptime,
  the status flags that are set, visit and data counters and the SD card size, plus every flag
  and counter behind a fold. Unknown flags are reported as unknown, never as healthy.
- `lp0_signal_checks` is validated byte by byte against the schema's min and max (the first
  byte array with real bounds); all-zero bounds stay unchecked as before. The LP0 communication
  parameters renderer in the list now names the real defaults (SF7, 250 kHz) and only shows a
  fifth byte where the schema has one (v7.0.0).
- `tests/browser-input-check.mjs` has an LP0 scenario: nothing on 8.0.1, panel, card, Features
  row and port list on 8.1, byte edits through the shared hidden input, Generate, the signal
  check gate, the start command and its reply, the station status block with a stored report
  and the SD card check, the state refresh, the delete confirmation, a replayed statistics
  record, and no panel or card for an 8.0 status with the 8.2.0 schema; and a new-logs scenario:
  the toggle and labels, the transfer start, the records, the state probe that completes the
  download, the empty, refused and cancelled cases, the legacy download with the toggle off,
  and no toggle on 8.0.

## Firmware v8 settings support

The app and HEX composer support both the legacy settings protocol and the family-based
protocol released in OpenCollar v8.0.0. The bundled `settings/settings-v8.0.0.json` is the
unmodified [v8.0.0 release asset](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/releases/tag/v8.0.0),
`settings/settings-v8.0.1.json`, `settings/settings-v8.0.2.json` and `settings/settings-v8.0.3.json`
are the unmodified
[v8.0.1](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/releases/tag/v8.0.1),
[v8.0.2](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/releases/tag/v8.0.2) and
[v8.0.3](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/releases/tag/v8.0.3) release assets.
The v8.0.1, v8.0.2 and v8.0.3 schemas are identical in content to v8.0.0; they are bundled so the app
selects the latest patch release and shows its firmware notes. Bundled DFU releases live in
`assets/dfu/releases/open-collar-v8.0.<patch>/` and `assets/dfu/releases/air-quality-v8.0.<patch>/`.
The v8.0.2 DFU bundles were removed on 2026-10-07 so the built-in list offers v8.0.3, which
fixes the missing `error_ublox` status flag; the v8.0.2 settings schema stays so devices still
on 8.0.2 can be read and updated.

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
node --test tests/settings-protocol.test.cjs tests/mcumgr.test.cjs tests/panel-engine.test.cjs tests/service-worker.test.cjs
```

`tests/browser-input-check.mjs` drives both pages in headless Chromium with real key, mouse and
touch events (desktop viewport, an emulated Android phone, and an emulated iPhone running Bluefy
with the third argument `ios`) and checks that every kind of panel input
stays editable while a value is retyped, that the settings-list interval never turns an empty field
into 0, and that the one-tap Apply flow writes, reads back and reports correctly against a fake
device. It needs a local server and a Chromium binary (`CHROME=...`), see the header of the file.

## Guided settings (in progress)

The settings list is being reworked into guided, task-oriented panels. Fourteen panels sit
above the settings list: Positioning (GPS), Data sending and storing (a message-type matrix
over the LoRaWAN, satellite, LP0 and flash-store flags), Network (LoRaWAN), Device and
security, Iridium satellite, S-Band satellite (its own panel, so the S-Band LoRa radio is not
mixed up with the Iridium modem), VHF beacon, WiFi scanning, BLE scanning, CMDQ,
Fence monitor, External switch, Air quality (its own panel), and Sensors (accelerometer; the
Memfault diagnostics interval sits under Device and security). The three schedules (GPS,
satellite, VHF) share one component: a switch, a schedule type (fixed or day/night),
intervals, and a 24-hour bar. The panels sit inside one collapsible "Settings" card, and
each panel can load the firmware defaults into the pending changes. Every panel is folded
whenever the panels are mounted, on every connection and visit, so the Settings card reads
as a short list of topics; a jump from the Features card or the pending chip opens the panel
it needs. The only search box is the one in the "All settings" card, which filters the
expert list; the guided card has none. The older
feature cards (CMDQ, FenceEdge, WiFi scan, BLE scan) keep their actions and results; their
settings blocks are hidden because the panels edit those settings now.

- `panels/panel-renderer.js` renders panels from the definitions. A panel is a view over the
  same state as the settings list: it reads effective values (pending edit, else the device
  value, else the default) and writes through the list inputs, so validation, the pending
  draft and "Review and apply" are shared. Fields whose keys the loaded schema lacks are
  skipped; fields gated by another setting are greyed out with the reason.

- `panels/panel-engine.js` holds the draft of pending edits, evaluates panel conditions,
  orders writes so dependents are written before a switch that enables them (and after one
  that disables them), and runs write-then-read-back verification. It has no DOM code and is
  tested in `tests/panel-engine.test.cjs`.
- `panels/panel-definitions.js` is the declarative panel format; the Positioning (GPS) panel
  is the reference definition. Keys absent from the loaded schema are skipped by renderers.
- Every setting's `display_name` in `settings-meta.json` names the setting on its own, without
  relying on the category header above it ("LED enabled", "status send interval", "GPS fix
  interval", "VHF night window start (UTC hour)"), since the All settings list, the import
  preview and gate reasons all show that name.
- `settings-meta.json` carries `categories` with a title, display order, and the order of
  settings inside each category; the settings list and the composer follow it instead of
  alphabetical order.
- Edits in the panels and the settings list collect in a draft. A bar offers "Apply", which
  writes in dependency order, reads each value back, shows progress in the bar and ends with a
  toast when the device confirmed everything; a mismatch, a failed write or an unconfirmed value
  opens a dialog with the outcome per setting. "Review" opens the before/after list first for
  people who want to check a larger edit. The per-setting Update buttons still work and clear
  their draft entry.
- Import uses the same ordered, verified apply path, always with the preview first. Export and
  import refuse to run while edits are pending, so a profile always matches what the device
  reported. The export writes only settings the device has actually sent (a toast says how
  many were left out when values are still arriving) and converts them with
  `exportSettingValue`, which treats the device's typed booleans and the inputs' strings alike.
  Exports made between 2026-09-25 and 2026-10-20 wrote every enabled on/off setting as `false`
  (the device's boolean was compared with the string "true"); re-export such profiles.
- A feature is set up first and switched on last (Tim, 2026-11-11): a feature's own on/off
  switch never greys out its settings, so the CMDQ search, fence, external switch, WiFi and BLE
  scanning, Iridium, S-Band, VHF, air quality, motion-triggered GPS, outdoor detection, satellite
  check and LP0 signal check settings can all be edited while the feature is off. These fields
  carry `dependsOn` instead of `enabledWhen`; it keeps the write order (settings before a switch
  that turns on, after one that turns off) without disabling anything. `enabledWhen` remains only
  where a field has no meaning in the current choice: day and night windows with a fixed
  schedule, the data rate without the Custom ADR profile, the manufacturer ID without a
  manufacturer filter, the movement window with "Skip fixes while still", the inactivity report
  without a periodic report, and LP0 fields of the other role (open while the role is Off). The
  GPS fix interval stays gated because that interval is itself the scheduled-fixes switch.
- Panel inputs never commit an empty or partial entry (a backspaced field, "5." on a number
  input) as 0: doing so flipped switches and gate conditions and disabled the field under the
  person's finger. The field is brought back in line with the draft when focus leaves it.
- The header is the "Smart Parks Connect" title next to the logo tile, with the blue DFU button as
  a tile of the logo's size and shape on the right (it becomes "Back" on the DFU page). Only the Status card is
  open after connecting; every other card, including the guided Settings card, starts folded.
- A device card sits above the Status card and stays pinned to the top of the screen while
  scrolling (`position: sticky`, drawn compact once it is stuck; the sticky wrapper keeps its
  full height while compact so the page below never shifts and the state cannot flicker). It
  shows the collar's
  animal icon and name, a connection dot, the type line ("Ranger · rangeredge v1.8"),
  firmware version, battery voltage, a pending-changes chip that jumps to the first edited
  field, and the Disconnect button. Tapping the name scrolls back to the top. The card
  hides on the DFU page and while disconnected; on narrow screens the firmware version, the
  type line (while stuck) and then the battery are dropped. The header's own Disconnect
  button is shown only on the DFU page, where the card is hidden, so the button never
  appears twice.
- The icons come from the Smart Parks Connect mobile app (`src/assets/*Icon.tsx` in
  SmartParksOrg/smartparks-connect-app, Copyright 2021 Vid Rajtmajer, Irnas d.o.o., GPL-3.0)
  and live in `device-icons.js`. The mapping follows the Connect app: the firmware type picks
  the animal when it reports one, the hardware type otherwise (rhino, elephant, wisent, cat,
  ranger; rhinopuck and rhinopuck35 show the rhino, collaredge and freeedge the cat), and an
  unknown type shows a plain collar outline.
- The Features card starts with a LoRaWAN row (2026-11-12): region and data rate on the first
  line ("EU 868 · DR5 = SF7 / 125 kHz", the same RP002 translation as the Network panel; with an
  ADR profile other than Custom the profile is named, since the data rate is not fixed then),
  and "Status every 1 h · rejoin every 1 h" on the second. The status interval is shown only
  while the status port is in `lr_send_flag`; otherwise the line says "Status not sent". The row
  counts as enabled unless the 8.2 `lr_enabled` switch is off, and a tap opens the Network panel.
- The Features card (the at-a-glance list above the panels) has a "Motion-triggered GPS" row
  of its own, since that switch is easy to leave on by accident and the GPS row only reflects
  the schedule. Its detail follows the Positioning panel's wording and says when the switch has
  no effect because scheduled fixes are off. Schedule starts in the card are shown in the
  browser's local time, not UTC, like the panels and the settings list.
- Message types are shown with their LoRaWAN port number wherever a send or store flag is
  edited or previewed: the Data sending and storing matrix, the confirmed and join port lists
  in the Network panel, the flag checkbox lists in the settings list and the composer, and the
  import and review previews. Backends and the firmware documentation identify messages by
  port, so a muted "port N" tag follows each name.
- The HEX composer mounts the same panels above its settings list. Editing a value in a
  panel ticks that setting for inclusion in the payload; unticking it in the list leaves it
  out again. Panel values that are not included show the firmware default.
- The Network panel's data rate (used with the Custom adaptive data rate profile) is a picker
  that follows the selected region: each entry reads "DR0 = SF12 / 125 kHz" for EU 868 but
  "DR0 = SF10 / 125 kHz" for US 915, following the LoRaWAN Regional Parameters (RP002)
  uplink tables in `panels/panel-engine.js` (`describeDataRate`). Data rates the region does
  not define are left out, a device value outside the table is shown as "not defined for this
  region", and US 915 and AU 915 DR8 to DR13 are marked downlink only. The Network summary and
  the helper under the raw number in the All settings list use the same translation.
- The guided panels open one at a time: opening a panel folds the one that was open.
- The "All settings" card starts with the search row, then an "Import / export" group (open by
  default) with the icon-labelled Import and Export buttons and the credential checkboxes,
  then the categories. The groups open one at a time, the open header is drawn in forest
  green, and groups sit 10 px apart.
- Experiment (2026-10-20): in the panels a field's help text is hidden behind an "i" button
  next to its label and opens on tap, so a panel reads as labels and controls. The constant
  `COLLAPSIBLE_HELP` at the top of `panels/panel-renderer.js` turns this off again. Group
  descriptions, gate reasons, warnings and validation errors stay visible.
- Help text in `settings-meta.json` and the panel definitions only states what the firmware
  READMEs document (VHF beeps per burst, S-Band send modes, port bitmasks, satellite retry
  timing, air quality duty cycle, report-empty options). Settings the firmware does not
  document keep a plain label without claims about behaviour.

## Status card

The charging item shows the charger input voltage while a charger is connected ("charging 5.3 V")
and "discharging" otherwise. The status message carries that voltage in one byte as 100 mV steps
above 5 V (`(charge_mV - 5000) / 100` in the firmware's `status.c`, 0 without a charger), so the
value has a resolution of 0.1 V. Until 2026-10-27 the app decoded the byte but only printed
"charging". The recent status messages table in the Logs card shows the same label.

## Actions card

The Actions card always offers the LoRaWAN join command. While the status message reports a
join error the button reads "Join LoRaWAN" and is highlighted in amber; otherwise the device
is considered joined and the same command is offered as "Re-join LoRaWAN". "Export settings"
in the Actions card saves the full profile, device credentials included, without opening the
All settings card; the export in the All settings card still follows its credentials checkbox. Both
refuse to export while edits are pending, so the file matches what the device reported.
"Import settings" (2026-11-12) sits next to it and opens the same file picker as the Import
button in the All settings card, so it runs the same preview and verified apply. It follows that
card's "include credentials" checkbox (off by default): a profile exported from another collar
never overwrites this collar's LoRaWAN keys unless someone ticks the box, and the preview says
when credentials are skipped. Every Actions button carries a small white icon before its label
(`mainCommandIcons` in `index.html` for the firmware commands; the six icons the stylesheet did not
have yet, satellite, satellite dish, ban, crosshairs, broadcast tower and paper plane, are Font
Awesome Free 6.7.2 like the others).

"Send satellite buffer now" (2026-11-11) sends `cmd_send_sat_buffer` (`20 C6 00`): the collar
sends the messages queued for satellite over Iridium at once, or a status message when the
queue is empty (`satellite_handle_commands` in the firmware's `satellite.c`). The button is only
shown while the collar reports `satellite_enabled` on and its modem detected (see "Satellite
modem" below); a pending edit that turns satellite on does not count, because the firmware drops
the command while satellite sending is off. With sending on and no modem found, the card offers
"Test satellite modem" in its place. The firmware answers nothing over Bluetooth when it takes
the send command, so the app shows a toast that the send started. The button stays disabled for
30 seconds after a tap, so a double tap does not pay for a second send.

## Satellite modem

Every status message says whether the collar found its RockBLOCK: bit 0 of the features byte
(status byte 15) is set once the modem answered a ping, and the high nibble is the number of
attempts the last satellite send took (`satellite_resend_try`: n means it got through on attempt
n, and a value equal to `satellite_retry` means every attempt was used, without saying whether
the last one got through). The firmware tests the modem in three cases: at boot while
`satellite_enabled` is on, when `satellite_enabled` is written while the modem has not been
detected, and at the start of every satellite send (`satellite_send_buffer` pings before it
sends). The test powers the modem, waits 5 s and pings it up to five times: about 8 s when it
answers, up to about 40 s when it does not. With satellite off the bit is therefore 0 even with
a working modem; with satellite on it reflects the last test, so a send whose ping fails clears it.

At boot the test runs inside the satellite thread's init, and the collar only starts Bluetooth
advertising once every thread has finished its init (`main.c`, 60 s init timeout). A collar
restarted with satellite on therefore becomes connectable about 8 s (modem answers) to 40 s (no
answer) later than one with satellite off, and its first status message already carries the
result. The RockBLOCK is powered only during a test or a send (FreeEdge: enable pin P0.02;
UART1 at 19200 baud on TX P0.11 and RX P0.08, no flow control); before a send the firmware also
sets echo on (`ATE1`), flow control off (`AT&K0`) and ring alerts off (`AT+SBDMTA=0`).

The Smart Parks Connect Android app only opens its satellite screen when this bit is set or the
collar is a Ranger, so on a FreeEdge with satellite off it says "This feature is not available
for this device" and offers no way to switch satellite on. This app never hides the switch.
Only rangeredge (type 5, the AirQ builds included) and freeedge (type 9) firmware is built with
`CONFIG_SATELLITE` (`SATELLITE_HW_TYPES` in `index.html`).

- The Status card shows "Satellite modem: detected / testing… / not found / not tested" on those
  collar types (and on any collar that reports a modem), the Features card's Satellite row names
  the same state, and the Iridium panel has a "Satellite modem" line that explains it, including
  the attempts of the last send. "Not tested" means satellite is off; "not found" means it is on
  and the modem did not answer. Other collar types get a panel line saying they have no modem
  port. The line is a `status` field in the panel definitions, filled by the host's `getStatus`;
  the composer has no device and does not show it.
- When the collar reports `satellite_enabled` switching from off to on (after Apply or an import)
  and has no modem yet, the app asks for the status after 12, 25 and 45 seconds and stops at the
  first one with the bit set: a toast says "Satellite modem detected", or after the last poll
  that the modem did not answer. "Test satellite modem" in the Actions card writes
  `satellite_enabled = true` again, which makes the firmware run the test once more, and polls
  the same way.

## Device time and location

The Status, Logs and Messenger cards have no refresh buttons: the status is requested on
connection and after the time and location update, the flash message count on connection
and after an erase, and the Messenger polls by itself. Every connection sets the collar's
clock and start position from the phone: as soon as the
first status message arrives, the app asks the browser for its position and sends it with the
current time (command `0xAF`), the same thing the "Set location & time" button in the Actions
card does. The button stays for a manual repeat. The device's confirmation shows a toast and
refreshes the status card, so the shown time and location are the new ones. If the browser
denies or cannot get a position, the app falls back to the collar's last known position so the
time is still set, and says so in a toast. Driver-update firmware (LR update, v5) is skipped,
as the button is hidden there as well. The update runs again after the automatic reconnect
that follows a DFU, since that is a new connection with a freshly booted collar.

## Message decoding

Rule (2026-11-06): every message type the firmware's TTN decoder (`scripts/ttn_decoder.js` in the
firmware repository, `ttn_decoder-vX.Y.Z.js` in a release) decodes for a bundled release must
decode in the app as well, in the Logs card's recent messages and in the Debug log for live
notifications. `MESSAGE_SUMMARIZERS` in `functions.js` holds the shared decoders (flash status,
LR1110 and u-blox satellites, GNSS scan, external switch detection and status, air quality,
Memfault chunks, LP0 statistics), each with a one-line summary and, where there are many values,
detail rows behind a fold. Positions, scans, CMDQ, fence, messenger and status messages are
decoded on the main page because they feed cards. `MESSAGES_WITHOUT_DECODER` lists the only
messages shown as raw bytes, with the reason (containers, replies, messages the firmware no
longer sends). The Node test "every message in every bundled schema has a decoder" fails when a
new schema brings a message that is in none of those places, so bundling a release means porting
its new decoders first. A live port-14 flash status message also updates the "Flash messages"
count in the Logs card together with the flash usage percentage.

## Recent stored messages

The Logs card shows the newest stored messages of any type without downloading the whole
flash log. The message type selector (status by default) feeds both "Show latest 10 stored
messages" and "Download all messages of this type". The latest-10 request uses
`CMD_FLASH_GET_FROM_HEAD` with start 0 for the selected port; records that arrive for other
ports are ignored. Status messages render as the familiar status table; every other type is
shown as a row with its age, message name, a decoded summary and the raw payload. The summary
uses the decoders the app already has (GNSS fix, short and resent positions, last position,
device timestamp, LR messaging text, CMDQ, FenceEdge, WiFi and BLE scans) and falls back to the
schema conversion or a byte count. The separate "Recent Status Logs" card is gone.

The cards below the map are ordered: Settings (guided panels), Logs, BLE scan, WiFi scan,
CMDQ, FenceEdge, Messenger, All settings, Commands, Firmware notes.

## Raw log downloads

On firmware 8.1 and newer the Logs card downloads only the records not yet delivered over
Bluetooth by default (see "Records remember how they were delivered" above); the legacy
download of everything stays behind the checkbox. Both produce the same file format.

Flash log downloads stream one packet per line (base64) into memory. If the connection drops,
the device stops answering, or the page is closed mid-download, the packets received so far are
not lost: the app saves them as `raw_logs-<type>-<device>_<timestamp>_PARTIAL-<n>msgs.txt` as
soon as the download is interrupted, and the overlay offers "Save partial log" and "Retry". While
a download runs, the packets are also mirrored to IndexedDB every 25 packets and on page unload;
on the next visit the app offers to save or discard an interrupted capture it finds there. The
device keeps all logs until "Erase all logs" is used, so Retry downloads the full set again from
the start. The last record in a partial file may be cut mid-message.

## DFU flow

DFU runs over MCUmgr SMP on the same GATT connection as the settings UART. Selecting a
built-in version checks it against the device immediately and, when the check is clean,
"Start DFU upload" is the only further click. The upload keeps up to three SMP packets in
flight (the "Packets in flight" setting in the Advanced card); the device answers each
packet with the offset it expects next, so a lost packet shows up as a repeated offset and
is resent, and the client drops back to one packet in flight after any timeout, loss or
rejected write. After the image is uploaded and marked for test, the app resets the device
and reconnects to the retained `BluetoothDevice` object automatically; no browser chooser is needed because
`gatt.connect()` does not require a user gesture, only `requestDevice()` does. The app
keeps retrying for up to three minutes while MCUboot swaps the image, then reads the
image state over SMP, checks that slot 0 carries the uploaded hash, and returns to the
device screen. The firmware confirms its own image on boot, so the SMP confirm step is a
safety net rather than a requirement. A screen wake lock is held during upload and
reboot. If automatic reconnect fails, the overlay offers a retry and a manual scan.

Chrome on macOS (2026-11-12): the automatic reconnect never came back there. CoreBluetooth has no
connect timeout, so a `gatt.connect()` issued while the collar is still swapping can wait
forever; the loop sat on its first attempt and never reached its three-minute deadline. Each
attempt is now cut off after 20 s (`AUTO_RECONNECT_ATTEMPT_TIMEOUT_MS` in `dfu/dfu.js`),
cancelled with `gatt.disconnect()`, and started again. After a minute of trying the overlay
also shows "Scan for device" while the attempts go on; a collar picked there replaces the
running attempt instead of being ignored, and closing the chooser keeps the session. That
chooser lists every Smart Parks collar (manufacturer filter only, every device on iOS): the
exact-name filter it used before matches nothing when macOS or iOS knows the collar by the
cached "Zephyr" GATT name (see the iPhone section).
The firmware version named in the completion toast, the overlay and the "already installed"
notice comes from the selected file's name (`...-v8.0.3.bin`), not from the MCUboot image
header: OpenCollar builds leave the header version at 0.0.0, and the hash check already
proves that the active image is the uploaded file. A header version is only used when it is
not all zeros; the slot cards show "not set in header" otherwise.

The DFU page shows only the header (its DFU tile reads "Back"), the DFU cards and the
firmware notes, which move under the Connected device card while DFU is open. Everything
else is hidden by one rule in `style.css`: every body-level `.page-section` other than the
header and `#dfu-section` is hidden while `body` carries `dfu-active`. `toggleDfuView` keeps
no list of cards to hide. A new card is kept off the DFU page by structure, so give it the
`page-section` class as a direct child of `body` and nothing else needs registering; this
list used to exist and the LP0 offload card was missed when it was added (fixed 2026-10-23).
`tests/browser-input-check.mjs` checks that the DFU view hides every such card, the LP0 card
included, and that leaving the DFU view brings them back.

The built-in version list is grouped so the right pick is the obvious one: a "Recommended"
group at the top holds the latest standard release (tagged "latest"), "Older standard firmware"
follows newest first (the v5.0.1 migration build is tagged "migration"), and air quality builds
sit in their own last group, "Air quality (AirQ) builds: only for collars with the air quality
sensor". The device cannot report whether it carries that sensor (the firmware type field has
no AirQ value), so a hint under the list says that most collars need the latest standard
firmware and that AirQ builds only run on rangeredge collars fitted with the sensor. The list
is filtered to the connected device's hardware type and version as before; AirQ entries are
only offered to rangeredge collars.

Adding a new bundled DFU firmware release:
- upload `.bin` files to `assets/dfu/releases/<release-id>/...`
- add release entries to `assets/dfu/manifest.json` (release id, firmware version, and file paths)
- the deploy stamps `CACHE_NAME` in `service-worker.js`, so the new worker fetches the new
  manifest and the pages cache the new binaries in the background; bump it by hand only to see
  the change locally
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
