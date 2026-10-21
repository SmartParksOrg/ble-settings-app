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
- add settings.json version to functions.js (`SETTINGS_FILES`, newest first)
- add settings.json version to service-worker.js and bump `CACHE_NAME`
- update the expected file in `tests/settings-protocol.test.cjs` ("schema selection")
- add firmware release notes to `device-version-notes.json` if you want notes shown in the UI

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

If something does not work, open the app menu, turn on **Debug** and send the log along with
the iPhone model, iOS version and Bluefy version (Bluefy settings show it).

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
- `viewport-fit=cover` plus `env(safe-area-inset-bottom)` padding keep the pending-changes bar
  and the bottom bars above the iPhone home indicator.

`tests/browser-input-check.mjs ... ios` emulates an iPhone running Bluefy (user agent, touch,
stubbed device picker, stubbed downloads) and checks these paths; the desktop and mobile runs
check that exports still download through an anchor and that the manufacturer filter stays.
Verification on a real iPhone with Bluefy is still open (see to-do.md).

## Firmware 8.1 development builds: LP0 offload (beta)

Firmware 8.1 is under development on the `fix/existing-lp0-implementation` branch of the
private firmware repository and is flashed by hand; the app bundles no DFU file for it. Its
settings schema, `settings/settings-v8.1.0.json`, is `scripts/settings/settings.json` from that
branch at commit 7bae042 (fetched 2026-10-20). Replace the file when the branch changes the
schema. Against 8.0.3 it adds four settings (`lp0_master_key`, `lp0_signal_checks`,
`lp0_focus_offloading`, `lp0_statistics_interval`), three commands (`cmd_offload_start` 0xCF,
`cmd_offload_cancel` 0xD1, `cmd_flash_clear_confirmed` 0xD2), the station statistics message
(port 23, id 0x9D) and new defaults for `flash_store_flag` and `lp0_send_flag` (port 23 set).

The eight LP0 settings that older schemas already have stay where they were: in the LP0 group
of the All settings list and as the LP0 column of the Data sending and storing matrix. The
LP0 features below are only offered when the device reports firmware 8.1 or newer and the
loaded schema carries the master key and the offload commands; they are hidden on 8.0.x, also
when someone picks the 8.1.0 schema by hand for an 8.0 collar. The composer shows the panel
whenever the 8.1.0 schema is selected.

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
  shows the last reply only. "Delete confirmed logs" asks first, then sends `20 D2 01 selector`
  (any medium, LP0 station, LoRaWAN, Bluetooth or satellite); the usual cmd_confirm reply
  shows a toast and refreshes the flash message count. The Bluetooth offload medium is not
  offered: the Logs card's download already covers it.
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
  check gate, the start command and its reply, the delete confirmation, a replayed statistics
  record, and no panel or card for an 8.0 status with the 8.1.0 schema.

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
node --test tests/settings-protocol.test.cjs tests/mcumgr.test.cjs tests/panel-engine.test.cjs
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

## Actions card

The Actions card always offers the LoRaWAN join command. While the status message reports a
join error the button reads "Join LoRaWAN" and is highlighted in amber; otherwise the device
is considered joined and the same command is offered as "Re-join LoRaWAN". "Export settings"
in the Actions card saves the full profile, device credentials included, without opening the
All settings card; the export in the All settings card still follows its credentials checkbox. Both
refuse to export while edits are pending, so the file matches what the device reported.

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
The firmware version named in the completion toast, the overlay and the "already installed"
notice comes from the selected file's name (`...-v8.0.3.bin`), not from the MCUboot image
header: OpenCollar builds leave the header version at 0.0.0, and the hash check already
proves that the active image is the uploaded file. A header version is only used when it is
not all zeros; the slot cards show "not set in header" otherwise.

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
