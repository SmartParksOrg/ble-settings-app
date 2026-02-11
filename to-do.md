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
- Service worker cache is currently `app-cache-v10`.
