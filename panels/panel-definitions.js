// Declarative definitions of the guided settings panels. Each panel lists fields in the
// order a person needs them; fields map to setting keys from the loaded schema. Keys that
// the connected firmware does not have are skipped by the renderer, so one definition
// serves every bundled firmware version.
//
// Field shapes:
//   { key, label, help, control, unit, zeroMeansOff, enabledWhen, reason, visibleWhen, writeAfter }
//   (`reason` is shown when enabledWhen is false; a group's reason applies to its fields)
//   { control: 'mode' | 'choice', label, keys: [...], options: [{ id, label, help, when, set, ensure }] }
//   { control: 'switch', label, keys, on: <condition>, turnOff: { key: value }, turnOn: { ensure: {...} } }
//   A duration with zeroMeansOff renders an on/off toggle; `onDefault` is the value used when
//   turned on with no remembered value, `offLabel` the text shown while off.
//   (`set` values are written when the option is chosen; `ensure` values only where the
//   current value is empty or zero, so a mode never leaves an interval at 0 = off)
//   { group, help, advanced, enabledWhen, fields: [...] }
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
        help: 'Fix quality and timing. The defaults suit most deployments.',
        fields: [
          { key: 'horizontal_accuracy', label: 'Horizontal accuracy', unit: 'm', help: 'Horizontal accuracy in metres.' },
          { key: 'cold_fix_timeout', label: 'Cold fix timeout', control: 'duration', unit: 's', help: 'Duration of a cold fix attempt (the first fix, without recent satellite data).' },
          { key: 'cold_fix_retry', label: 'Cold fix retries', help: 'Number of cold fix attempts before the GPS module is turned off.' },
          { key: 'hot_fix_timeout', label: 'Hot fix timeout', control: 'duration', unit: 's', help: 'Duration of a hot fix attempt (fixes after a successful cold fix).' },
          { key: 'hot_fix_retry', label: 'Hot fix retries', help: 'Number of hot fix attempts.' },
          { key: 'ublox_min_satellites', label: 'Minimum satellites', help: 'Satellites that must be visible to keep trying. 0 disables the check.' },
          { key: 'ublox_min_satellites_timer', label: 'Satellite check after', control: 'duration', unit: 's', help: 'Seconds into an attempt before checking whether enough satellites are visible to continue.' },
          { key: 'ublox_min_fix_time', label: 'Minimum fix time', control: 'duration', unit: 's', help: 'Minimum fix time in seconds.' },
          { key: 'ublox_leave_on', label: 'Receiver stays on after a fix', control: 'duration', unit: 's', help: 'How long the receiver stays on after a fix completes.' },
          { key: 'gps_backoff_factor', label: 'Backoff after failed fix', help: 'Delay applied to the next fix after an unsuccessful attempt.' },
          { key: 'ublox_cold_fix_hour_interval', label: 'Limit cold fix attempts', control: 'duration', unit: 'h', zeroMeansOff: true, onDefault: 24, offLabel: 'No limit', help: 'How often a cold fix attempt is allowed, in hours.' },
          { key: 'gps_init_lat', label: 'Initial latitude', control: 'coordinate', help: 'Initial latitude in decimal degrees.' },
          { key: 'gps_init_lon', label: 'Initial longitude', control: 'coordinate' },
        ],
      },
    ],
  };

  return {
    version: 1,
    panels: [positioning],
  };
}));
