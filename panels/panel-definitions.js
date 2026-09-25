// Declarative definitions of the guided settings panels. Each panel lists fields in the
// order a person needs them; fields map to setting keys from the loaded schema. Keys that
// the connected firmware does not have are skipped by the renderer, so one definition
// serves every bundled firmware version.
//
// Field shapes:
//   { key, label, help, control, unit, zeroMeansOff, enabledWhen, reason, visibleWhen, writeAfter,
//     warnings: [{ when: <condition>, text }] }   (a warning shows while its condition holds)
//   (`reason` is shown when enabledWhen is false; a group's reason applies to its fields)
//   { control: 'mode' | 'choice', label, keys: [...], options: [{ id, label, help, when, set, ensure }] }
//   { control: 'switch', label, keys, on: <condition>, turnOff: { key: value }, turnOn: { ensure: {...} } }
//   { control: 'text' | 'pin' | 'select' | 'hex' | 'ports', key, ... }   (hex: secret: true masks the value)
//   { control: 'matrix', columns: [{ key, label, summaryLabel }] }  (rows are the schema's message ports)
//   Panel: { id, title, icon, collapsed, description, summary, fields }
//   summary is an id ('positioning', 'data', 'network', 'device') or { type: 'schedule', ...keys }
//   zeroMeansOff fields may carry onAlso: [{ key, value, when }] applied when switched on.
//   A duration with zeroMeansOff renders an on/off toggle; `onDefault` is the value used when
//   turned on with no remembered value, `offLabel` the text shown while off.
//   (`set` values are written when the option is chosen; `ensure` values only where the
//   current value is empty or zero, so a mode never leaves an interval at 0 = off)
//   { group, help, advanced, summary, enabledWhen, fields: [...] }   (groups may nest one level)
// Conditions use the PanelEngine forms: { key, equals | truthy | gt ... }, { all }, { any }, { not }.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PanelDefinitions = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const dayNightOn = { key: 'ublox_multiple_intervals', truthy: true };
  const scheduleOn = { any: [{ key: 'ublox_send_interval', gt: 0 }, dayNightOn] };
  const motionOn = { key: 'enable_motion_trig_gps', truthy: true };
  const outdoorOn = { key: 'outdoor_detection_enabled', truthy: true };
  const windowMode = { all: [motionOn, { key: 'gps_triggered_interval', gt: 0 }, { key: 'gps_motion_triggered_min_num_of_triggers_per_interval', gt: 0 }] };
  const dayNightReason = 'Only used with the day and night schedule.';
  const motionReason = 'Turn on motion-triggered GPS first.';
  const outdoorReason = 'Turn on outdoor detection first.';
  const windowReason = 'Only used with the "Fix after repeated movement" behaviour.';

  const positioning = {
    id: 'positioning',
    title: 'Positioning (GPS)',
    connectAppSection: 'GPS',
    description: 'When the tracker takes a GNSS position fix, and how hard it tries to get one.',
    summary: 'positioning',
    fields: [
      {
        control: 'switch',
        label: 'Scheduled fixes',
        keys: ['ublox_send_interval', 'ublox_multiple_intervals'],
        on: { any: [{ key: 'ublox_send_interval', gt: 0 }, { key: 'ublox_multiple_intervals', truthy: true }] },
        turnOff: { ublox_send_interval: 0, ublox_multiple_intervals: false },
        turnOn: { ensure: { ublox_send_interval: 300 } },
        help: 'Take position fixes on a schedule. When off, motion-triggered and outdoor detection have no effect either.',
      },
      {
        control: 'choice',
        label: 'Schedule type',
        keys: ['ublox_multiple_intervals'],
        enabledWhen: scheduleOn,
        reason: 'Turn on scheduled fixes first.',
        options: [
          {
            id: 'fixed',
            label: 'Fixed interval',
            help: 'One interval, all day.',
            when: { key: 'ublox_multiple_intervals', truthy: false },
            set: { ublox_multiple_intervals: false },
            ensure: { ublox_send_interval: 300 },
          },
          {
            id: 'day-night',
            label: 'Day and night schedule',
            help: 'Two intervals: one from the day start hour, another from the night start hour (UTC).',
            when: dayNightOn,
            set: { ublox_multiple_intervals: true },
            ensure: { ublox_send_interval: 300, ublox_send_interval_2: 3600 },
          },
        ],
      },
      { key: 'ublox_send_interval', label: 'Fix interval', control: 'duration', unit: 's', enabledWhen: scheduleOn, reason: 'Turn on scheduled fixes first.',
        help: 'Time between position fixes. With the day and night schedule this is the daytime interval.' },
      { key: 'ublox_interval1_start', label: 'Day window starts', control: 'utc-hour', enabledWhen: dayNightOn, reason: dayNightReason,
        help: 'UTC hour when the daytime interval starts. Shown with your local time.' },
      { key: 'ublox_send_interval_2', label: 'Night interval', control: 'duration', unit: 's', zeroMeansOff: true, onDefault: 3600, offLabel: 'No fixes at night', enabledWhen: dayNightOn, reason: dayNightReason,
        help: 'Time between fixes from the night start hour until the day start hour.' },
      { key: 'ublox_interval2_start', label: 'Night window starts', control: 'utc-hour', enabledWhen: dayNightOn, reason: dayNightReason,
        help: 'UTC hour when the night interval starts.' },
      { key: 'ublox_active_tracking', label: 'Active tracking', control: 'toggle',
        help: 'Keep the GNSS receiver on between fixes. Adds heading and speed to position reports. Uses considerably more battery.' },
      { key: 'gps_resend_interval', label: 'Resend last position', control: 'duration', unit: 's', zeroMeansOff: true, onDefault: 600,
        help: 'How often the last known position is sent.' },
      {
        group: 'Motion-triggered fixes',
        help: 'Use the accelerometer to decide when a fix is worth taking.',
        fields: [
          { key: 'enable_motion_trig_gps', label: 'Motion-triggered GPS', control: 'toggle',
            help: 'When the tracker is not moving, scheduled fixes are skipped.' },
          { key: 'motion_ths', label: 'Motion sensitivity', enabledWhen: motionOn, reason: motionReason,
            help: 'Accelerometer threshold that counts as movement (see the LIS2DW12 datasheet).' },
          {
            control: 'choice',
            label: 'Behaviour',
            keys: ['gps_triggered_interval', 'gps_motion_triggered_min_num_of_triggers_per_interval'],
            enabledWhen: motionOn,
            reason: motionReason,
            options: [
              {
                id: 'skip',
                label: 'Skip fixes while still',
                help: 'Keep the schedule, but skip fixes while nothing moves, up to a maximum number of skips.',
                when: { any: [{ key: 'gps_triggered_interval', equals: 0 }, { key: 'gps_motion_triggered_min_num_of_triggers_per_interval', equals: 0 }] },
                set: { gps_triggered_interval: 0, gps_motion_triggered_min_num_of_triggers_per_interval: 0 },
              },
              {
                id: 'window',
                label: 'Fix after repeated movement',
                help: 'Take an extra fix when enough movements happen within a time window.',
                when: { all: [{ key: 'gps_triggered_interval', gt: 0 }, { key: 'gps_motion_triggered_min_num_of_triggers_per_interval', gt: 0 }] },
                set: { gps_triggered_interval: 60, gps_motion_triggered_min_num_of_triggers_per_interval: 5 },
              },
            ],
          },
          { key: 'gps_skipped_triggered_interval', label: 'Maximum skipped fixes', enabledWhen: motionOn, reason: motionReason,
            help: 'After this many skipped intervals a fix is taken even without movement. 0 fixes on every interval.' },
          { key: 'gps_triggered_interval', label: 'Movement window', control: 'duration', unit: 's',
            enabledWhen: windowMode, reason: windowReason,
            help: 'Length of the window in which movements are counted.' },
          { key: 'gps_motion_triggered_min_num_of_triggers_per_interval', label: 'Movements needed in window',
            enabledWhen: windowMode, reason: windowReason,
            help: 'Number of movements within the window that trigger a fix.' },
        ],
      },
      {
        group: 'Outdoor detection (experimental)',
        advanced: true,
        help: 'Only tested on the Pangolin deployment in Namibia. Do not enable it for other applications. Takes fixes when the tracker is probably outside, estimated from temperature, movement and time of day.',
        fields: [
          { key: 'outdoor_detection_enabled', label: 'Only fix when likely outdoors', control: 'toggle',
            help: 'Fixes are attempted when the tracker is probably outdoors instead of on every interval. Needs a fix schedule.' },
          { key: 'outdoor_detection_tau', label: 'Outdoor probability threshold', enabledWhen: outdoorOn, reason: outdoorReason,
            help: 'Probability required before a fix is attempted.' },
          { key: 'outdoor_detection_parameters', label: 'Model weights', control: 'bytes', enabledWhen: outdoorOn, reason: outdoorReason, advanced: true },
        ],
      },
      {
        group: 'Advanced fix settings',
        advanced: true,
        summary: 'fix-quality',
        help: 'How a fix attempt runs. The first fix after a long gap is a cold fix; once one succeeds, later fixes are hot fixes. The defaults suit most deployments.',
        fields: [
          {
            group: 'Cold fix (first fix, no recent satellite data)',
            fields: [
              { key: 'cold_fix_timeout', label: 'Attempt duration', control: 'duration', unit: 's',
                help: 'Duration of a cold fix attempt.' },
              { key: 'cold_fix_retry', label: 'Attempts',
                help: 'Number of cold fix attempts. After the last unsuccessful one the GPS module is turned off.' },
              { key: 'ublox_cold_fix_hour_interval', label: 'Limit cold fix attempts', control: 'duration', unit: 'h', zeroMeansOff: true, onDefault: 24, offLabel: 'No limit',
                help: 'How often a cold fix attempt is allowed, in hours.' },
            ],
          },
          {
            group: 'Hot fix (after a successful fix)',
            fields: [
              { key: 'hot_fix_timeout', label: 'Attempt duration', control: 'duration', unit: 's',
                help: 'Duration of a hot fix attempt.' },
              { key: 'hot_fix_retry', label: 'Attempts',
                help: 'Number of hot fix attempts before the fix is given up.' },
            ],
          },
          {
            group: 'Abandon attempts with too few satellites',
            help: 'Part-way into an attempt the receiver checks how many satellites it sees; with too few, the attempt is abandoned instead of running to its full duration. The check is off when the satellite count is 0; the timer below has no off value.',
            fields: [
              { key: 'ublox_min_satellites', label: 'Satellite check', zeroMeansOff: true, onDefault: 3, offLabel: 'Off',
                onAlso: [{ key: 'ublox_min_satellites_timer', value: 30, when: { key: 'ublox_min_satellites_timer', lt: 5 } }],
                help: 'Satellites needed to continue the attempt.' },
              { key: 'ublox_min_satellites_timer', label: 'Check after', control: 'duration', unit: 's',
                enabledWhen: { key: 'ublox_min_satellites', gt: 0 }, reason: 'Turn on the satellite check first.',
                help: 'Seconds into an attempt at which the satellite count is checked. The firmware minimum is 5 seconds; the default is 30.',
                warnings: [{ when: { key: 'ublox_min_satellites_timer', lt: 5 },
                  text: 'The device reports a value below the firmware minimum of 5 seconds (often 0 after an upgrade from older firmware). The check then runs every second and can stop fixes before satellites are found. Set it to 30 seconds.' }] },
            ],
          },
          {
            group: 'Fix result and follow-up',
            fields: [
              { key: 'horizontal_accuracy', label: 'Horizontal accuracy', unit: 'm', help: 'Horizontal accuracy in metres.' },
              { key: 'ublox_min_fix_time', label: 'Minimum search time', control: 'duration', unit: 's', help: 'Minimum time the receiver keeps searching for GNSS satellites in order to make a fix.' },
              { key: 'ublox_leave_on', label: 'Receiver stays on after a fix', control: 'duration', unit: 's', help: 'How long the receiver stays on after a fix completes.' },
              { key: 'gps_backoff_factor', label: 'Backoff after failed fix', help: 'Delay applied to the next fix after an unsuccessful attempt.' },
            ],
          },
          {
            group: 'Initial position',
            help: 'Position stored on the device before any fix has been made.',
            fields: [
              { key: 'gps_init_lat', label: 'Initial latitude', control: 'coordinate', help: 'Initial latitude in decimal degrees.' },
              { key: 'gps_init_lon', label: 'Initial longitude', control: 'coordinate', help: 'Initial longitude in decimal degrees.' },
            ],
          },
        ],
      },
    ],
  };

  // Message types (LoRaWAN ports) as people know them. Unknown ports fall back to the
  // port name without its prefix.
  const portLabels = {
    port_lr_gps: 'LR GPS position',
    port_ublox_gps: 'GPS position',
    port_ublox_short_message: 'GPS position (short)',
    port_ublox_resend_location: 'Last position resend',
    port_ublox_sat_data: 'GPS satellite data',
    port_lr_sat_data: 'LR satellite data',
    port_settings: 'Settings',
    port_status: 'Status report',
    port_timestamp: 'Timestamp',
    port_flash_status: 'Flash status',
    port_wifi_scan: 'WiFi scan',
    port_wifi_scan_aggregated: 'WiFi scan (aggregated)',
    port_ble_scan: 'BLE scan',
    port_ble_scan_aggregated: 'BLE scan (aggregated)',
    port_ble_cmdq: 'CMDQ detections',
    port_fence: 'Fence measurement',
    port_external_switch_detection: 'Switch detection',
    port_external_switch_detection_status: 'Switch status',
    port_air_quality: 'Air quality',
    port_lp0_ping: 'LP0 ping',
    port_lp0_commands: 'LP0 commands',
    port_memfault: 'Memfault diagnostics',
    port_rf_scan: 'RF scan',
  };

  const dataSending = {
    id: 'data',
    title: 'Data sending and storing',
    icon: 'envelope',
    connectAppSection: 'Data sending and storing',
    description: 'Which message types the tracker sends over LoRaWAN, sends over satellite, and stores in the flash log.',
    summary: 'data',
    fields: [
      {
        control: 'matrix',
        label: 'Message types',
        keys: [],
        columns: [
          { key: 'lr_send_flag', label: 'LoRaWAN', summaryLabel: 'over LoRaWAN' },
          { key: 'sat_send_flag', label: 'Satellite', summaryLabel: 'over satellite' },
          { key: 'lp0_send_flag', label: 'LP0', summaryLabel: 'over LP0' },
          { key: 'flash_store_flag', label: 'Store', summaryLabel: 'stored to flash' },
        ],
        help: 'Each row is a message type. Tick where it should go.',
      },
      {
        group: 'Flash log',
        advanced: true,
        fields: [
          { key: 'data_log', label: 'Flash data log', control: 'toggle', help: 'Enable the flash data log.' },
          { key: 'flash_status_interval', label: 'Flash status report', control: 'duration', unit: 's', zeroMeansOff: true, onDefault: 86400,
            help: 'How often flash status updates are generated.' },
        ],
      },
    ],
  };

  const customAdr = { key: 'lr_adr_profile', equals: 3 };

  const network = {
    id: 'network',
    title: 'Network (LoRaWAN)',
    icon: 'messages',
    connectAppSection: 'LoRa',
    collapsed: true,
    description: 'How the tracker joins and talks to the LoRaWAN network.',
    summary: 'network',
    fields: [
      { key: 'lr_region', label: 'Region', control: 'select', help: 'LoRaWAN frequency region. Changing it makes the device rejoin the network.' },
      { key: 'lr_adr_profile', label: 'Adaptive data rate', control: 'select',
        help: 'Network controlled suits static devices; the mobile profiles suit moving trackers; Custom uses the data rate below.' },
      { key: 'lr_adr', label: 'Data rate', enabledWhen: customAdr, reason: 'Only used with the Custom adaptive data rate profile.',
        help: 'DR0 to DR15. EU 868 allows DR0 to DR7; US 915 allows DR0 to DR4 and DR8 to DR13.' },
      { key: 'rejoin_interval', label: 'Rejoin interval', control: 'duration', unit: 's', help: 'How often the device tries to rejoin the network while not joined.' },
      {
        group: 'Credentials',
        help: 'Changing the app EUI or app key makes the device rejoin the network. Credentials are only exported when the export option is ticked.',
        fields: [
          { key: 'device_eui', label: 'Device EUI', control: 'hex', help: 'The unique ID for this device, read from the LoRa chip by the firmware.',
            warnings: [{ when: { key: 'device_eui', in: ['0000000000000000', ''] },
              text: 'The device reports an all-zero Device EUI. The firmware fills this from the LoRa chip after the modem is configured; an all-zero value means that has not happened yet, or the stored value was overwritten. The network join uses the chip EUI regardless, so joining is not affected, but do not copy this value as the device identity.' }] },
          { key: 'app_eui', label: 'App EUI (Join EUI)', control: 'hex', help: 'The app ID used when joining the network.' },
          { key: 'app_key', label: 'App key', control: 'hex', secret: true, help: 'The key used to join the network.' },
        ],
      },
      {
        group: 'Messaging',
        help: 'Retries for messages sent from the Messenger card.',
        fields: [
          { key: 'lr_messaging_retry_interval', label: 'Retry interval', control: 'duration', unit: 's', help: 'How long the device waits between messaging retry attempts.' },
          { key: 'lr_messaging_retry_count', label: 'Retries', help: 'Number of retry attempts.' },
        ],
      },
      {
        group: 'Advanced',
        advanced: true,
        fields: [
          { key: 'lr_max_confirm_fail', label: 'Maximum confirmed-message failures', help: 'Maximum number of failed confirmed messages.' },
          { key: 'lr_confirm_flag', label: 'Send as confirmed messages', control: 'ports', help: 'Message types sent as confirmed uplinks.' },
          { key: 'lr_join_flag', label: 'Join before sending', control: 'ports', help: 'Message types for which the device attempts to join first when it is not joined.' },
        ],
      },
    ],
  };

  const device = {
    id: 'device',
    title: 'Device and security',
    icon: 'locked',
    connectAppSection: 'Security',
    collapsed: true,
    description: 'Name, Bluetooth access, and how often the tracker reports its status.',
    summary: 'device',
    fields: [
      { key: 'device_name', label: 'Device name', control: 'text', help: 'Name shown in Bluetooth scans (up to 8 characters).' },
      { key: 'device_pin', label: 'Bluetooth PIN', control: 'pin', help: 'Four digits required to connect over Bluetooth. 0000 means no PIN is checked.' },
      { key: 'led_enabled', label: 'Status LED', control: 'toggle', help: 'Enable the status LED.' },
      { key: 'status_send_interval', label: 'Status report interval', control: 'duration', unit: 's', help: 'How often the device sends a status update.' },
      {
        group: 'Advanced',
        advanced: true,
        fields: [
          { key: 'check_error_interval', label: 'Error check interval', control: 'duration', unit: 's', help: 'How often the device checks for error conditions.' },
          { key: 'tracker_type', label: 'Tracker type', control: 'select', help: 'Tracker model type.' },
        ],
      },
    ],
  };

  function scheduleTypeField(multipleKey, interval1Key, interval2Key, enabledWhen, reason) {
    return {
      control: 'choice',
      label: 'Schedule type',
      keys: [multipleKey],
      enabledWhen,
      reason,
      options: [
        { id: 'fixed', label: 'Fixed interval', help: 'One interval, all day.',
          when: { key: multipleKey, truthy: false }, set: { [multipleKey]: false } },
        { id: 'day-night', label: 'Day and night schedule', help: 'Two intervals: one from the day start hour, another from the night start hour (UTC).',
          when: { key: multipleKey, truthy: true }, set: { [multipleKey]: true },
          ensure: { [interval1Key]: 3600, [interval2Key]: 86400 } },
      ],
    };
  }

  const satelliteOn = { key: 'satellite_enabled', truthy: true };
  const satelliteDayNight = { key: 'satellite_multiple_intervals', truthy: true };
  const satelliteReason = 'Turn on the satellite modem first.';
  const satelliteDayNightReason = 'Only used with the day and night schedule.';

  const satellite = {
    id: 'satellite',
    title: 'Iridium satellite',
    icon: 'square-caret-up',
    connectAppSection: 'Satellite',
    collapsed: true,
    description: 'When the tracker sends data over the Iridium satellite modem. Which message types go over satellite is set in Data sending and storing.',
    summary: { type: 'schedule', enabledKey: 'satellite_enabled', interval1Key: 'satellite_send_interval', multipleKey: 'satellite_multiple_intervals',
      start1Key: 'satellite_interval1_start', interval2Key: 'satellite_send_interval2', start2Key: 'satellite_send_interval2_start', verb: 'Send', subject: 'Satellite sending' },
    fields: [
      { key: 'satellite_enabled', label: 'Satellite sending', control: 'toggle', help: 'Send queued messages over the Iridium satellite modem.' },
      scheduleTypeField('satellite_multiple_intervals', 'satellite_send_interval', 'satellite_send_interval2', satelliteOn, satelliteReason),
      { key: 'satellite_send_interval', label: 'Send interval', control: 'duration', unit: 's', enabledWhen: satelliteOn, reason: satelliteReason,
        help: 'Time between satellite send attempts. With the day and night schedule this is the daytime interval.' },
      { key: 'satellite_interval1_start', label: 'Day window starts', control: 'utc-hour', enabledWhen: { all: [satelliteOn, satelliteDayNight] }, reason: satelliteDayNightReason,
        help: 'UTC hour when the daytime interval starts.' },
      { key: 'satellite_send_interval2', label: 'Night interval', control: 'duration', unit: 's', zeroMeansOff: true, onDefault: 86400, offLabel: 'No sending at night',
        enabledWhen: { all: [satelliteOn, satelliteDayNight] }, reason: satelliteDayNightReason,
        help: 'Time between send attempts from the night start hour until the day start hour.' },
      { key: 'satellite_send_interval2_start', label: 'Night window starts', control: 'utc-hour', enabledWhen: { all: [satelliteOn, satelliteDayNight] }, reason: satelliteDayNightReason,
        help: 'UTC hour when the night interval starts.' },
      {
        group: 'Advanced',
        advanced: true,
        fields: [
          { key: 'satellite_retry', label: 'Send retries', enabledWhen: satelliteOn, reason: satelliteReason, help: 'Satellite retry setting.' },
          { key: 's_band_send_mode', label: 'S-Band send mode', help: 'S-band related setting.' },
          { key: 's_band_send_interval', label: 'S-Band send interval', control: 'duration', unit: 's', zeroMeansOff: true, onDefault: 3600,
            help: 'How often an S-Band satellite message is sent.' },
          { key: 's_band_rf_frequency_hz', label: 'S-Band frequency', unit: 'Hz', help: 'S-band related setting.' },
        ],
      },
    ],
  };

  const vhfOn = { key: 'vhf_enabled', truthy: true };
  const vhfDayNight = { key: 'vhf_multiple_intervals', truthy: true };
  const vhfReason = 'Turn on the VHF beacon first.';
  const vhfDayNightReason = 'Only used with the day and night schedule.';

  const vhf = {
    id: 'vhf',
    title: 'VHF beacon',
    icon: 'bars',
    collapsed: true,
    description: 'When the tracker transmits VHF beacon pulses for directional tracking.',
    summary: { type: 'schedule', enabledKey: 'vhf_enabled', interval1Key: 'vhf_interval1', multipleKey: 'vhf_multiple_intervals',
      start1Key: 'vhf_interval1_start', interval2Key: 'vhf_interval2', start2Key: 'vhf_interval2_start', verb: 'Transmit', subject: 'The VHF beacon' },
    fields: [
      { key: 'vhf_enabled', label: 'VHF beacon', control: 'toggle', help: 'Transmit VHF beacon pulses on the schedule below.' },
      scheduleTypeField('vhf_multiple_intervals', 'vhf_interval1', 'vhf_interval2', vhfOn, vhfReason),
      { key: 'vhf_interval1', label: 'Transmit interval', control: 'duration', unit: 's', enabledWhen: vhfOn, reason: vhfReason,
        help: 'Time between beacon bursts. With the day and night schedule this is the daytime interval.' },
      { key: 'vhf_interval1_start', label: 'Day window starts', control: 'utc-hour', enabledWhen: { all: [vhfOn, vhfDayNight] }, reason: vhfDayNightReason,
        help: 'UTC hour when the daytime interval starts.' },
      { key: 'vhf_interval2', label: 'Night interval', control: 'duration', unit: 's', zeroMeansOff: true, onDefault: 60, offLabel: 'No beacon at night',
        enabledWhen: { all: [vhfOn, vhfDayNight] }, reason: vhfDayNightReason,
        help: 'Time between bursts from the night start hour until the day start hour.' },
      { key: 'vhf_interval2_start', label: 'Night window starts', control: 'utc-hour', enabledWhen: { all: [vhfOn, vhfDayNight] }, reason: vhfDayNightReason,
        help: 'UTC hour when the night interval starts.' },
      {
        group: 'Transmitter',
        advanced: true,
        help: 'Radio parameters of the beacon. Match them to the receiver in use.',
        fields: [
          { key: 'vhf_tx_frequency_khz', label: 'Frequency', unit: 'kHz', help: 'Transmit frequency in kHz.' },
          { key: 'vhf_num_of_packets_per_burst', label: 'Pulses per burst', help: 'Number of pulses transmitted per burst.' },
          { key: 'vhf_time_between_packets_ms', label: 'Time between pulses', unit: 'ms', help: 'Milliseconds between pulses within a burst.' },
          { key: 'vhf_single_pulse_duration_ms', label: 'Pulse duration', unit: 'ms', help: 'Duration of a single pulse in milliseconds.' },
          { key: 'vhf_external_path', label: 'External antenna path', control: 'toggle', help: 'Vhf external path setting.' },
        ],
      },
    ],
  };

  return {
    version: 3,
    panels: [positioning, dataSending, network, device, satellite, vhf],
    portLabels,
  };
}));
