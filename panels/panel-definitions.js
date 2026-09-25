// Declarative definitions of the guided settings panels. Each panel lists fields in the
// order a person needs them; fields map to setting keys from the loaded schema. Keys that
// the connected firmware does not have are skipped by the renderer, so one definition
// serves every bundled firmware version.
//
// Field shapes:
//   { key, label, help, control, unit, zeroMeansOff, enabledWhen, reason, visibleWhen, writeAfter }
//   (`reason` is shown when enabledWhen is false; a group's reason applies to its fields)
//   { control: 'mode' | 'choice', label, keys: [...], options: [{ id, label, help, when, set, ensure }] }
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
        control: 'mode',
        label: 'Fix schedule',
        keys: ['ublox_send_interval', 'ublox_multiple_intervals'],
        options: [
          {
            id: 'off',
            label: 'Off',
            help: 'No scheduled fixes. Motion-triggered and outdoor-triggered fixes still work if enabled.',
            when: { all: [{ key: 'ublox_send_interval', equals: 0 }, { key: 'ublox_multiple_intervals', truthy: false }] },
            set: { ublox_send_interval: 0, ublox_multiple_intervals: false },
          },
          {
            id: 'fixed',
            label: 'Fixed interval',
            help: 'One interval, all day.',
            when: { all: [{ key: 'ublox_send_interval', gt: 0 }, { key: 'ublox_multiple_intervals', truthy: false }] },
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
      { key: 'ublox_send_interval', label: 'Fix interval', control: 'duration', unit: 's', zeroMeansOff: true,
        help: 'Time between position fixes. With the day and night schedule this is the daytime interval.' },
      { key: 'ublox_interval1_start', label: 'Day window starts', control: 'utc-hour', enabledWhen: dayNightOn, reason: dayNightReason,
        help: 'UTC hour when the daytime interval starts. Shown with your local time.' },
      { key: 'ublox_send_interval_2', label: 'Night interval', control: 'duration', unit: 's', zeroMeansOff: true, enabledWhen: dayNightOn, reason: dayNightReason,
        help: 'Time between fixes from the night start hour until the day start hour.' },
      { key: 'ublox_interval2_start', label: 'Night window starts', control: 'utc-hour', enabledWhen: dayNightOn, reason: dayNightReason,
        help: 'UTC hour when the night interval starts.' },
      { key: 'ublox_active_tracking', label: 'Active tracking', control: 'toggle',
        help: 'Keep the GNSS receiver on between fixes. Adds heading and speed to position reports. Uses considerably more battery.' },
      { key: 'gps_resend_interval', label: 'Resend last position', control: 'duration', unit: 's', zeroMeansOff: true,
        help: 'How often the last known position is sent again without a new fix.' },
      {
        group: 'Outdoor detection',
        help: 'Take fixes only when the tracker is probably outside, based on temperature, movement and time of day.',
        fields: [
          { key: 'outdoor_detection_enabled', label: 'Only fix when likely outdoors', control: 'toggle',
            help: 'Replaces the fixed interval with fixes triggered by the outdoor estimate. Can be combined with motion-triggered fixes.' },
          { key: 'outdoor_detection_tau', label: 'Outdoor probability threshold', enabledWhen: outdoorOn, reason: outdoorReason,
            help: 'Probability required before a fix is attempted.' },
          { key: 'outdoor_detection_parameters', label: 'Model weights', control: 'bytes', enabledWhen: outdoorOn, reason: outdoorReason, advanced: true },
        ],
      },
      {
        group: 'Motion-triggered fixes',
        help: 'Use the accelerometer to decide when a fix is worth taking.',
        fields: [
          { key: 'enable_motion_trig_gps', label: 'Motion-triggered GPS', control: 'toggle',
            help: 'When the tracker is not moving, scheduled fixes are skipped.' },
          { key: 'motion_ths', label: 'Motion sensitivity', enabledWhen: motionOn, reason: motionReason,
            help: 'Accelerometer threshold that counts as movement. Lower is more sensitive.' },
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
        group: 'Advanced fix settings',
        advanced: true,
        help: 'Fix quality and timing. The defaults suit most deployments.',
        fields: [
          { key: 'horizontal_accuracy', label: 'Required accuracy', unit: 'm', help: 'A fix is accepted once its horizontal accuracy is within this distance.' },
          { key: 'cold_fix_timeout', label: 'Cold fix timeout', control: 'duration', unit: 's', help: 'Maximum time for a fix when the receiver has no recent satellite data.' },
          { key: 'cold_fix_retry', label: 'Cold fix retries', help: 'Attempts before the receiver gives up on a cold fix.' },
          { key: 'hot_fix_timeout', label: 'Hot fix timeout', control: 'duration', unit: 's', help: 'Maximum time for a fix shortly after a previous successful fix.' },
          { key: 'hot_fix_retry', label: 'Hot fix retries', help: 'Attempts before a hot fix is abandoned.' },
          { key: 'ublox_min_satellites', label: 'Minimum satellites', help: 'Satellites that must be visible to keep trying. 0 disables the check.' },
          { key: 'ublox_min_satellites_timer', label: 'Satellite check after', control: 'duration', unit: 's', help: 'Seconds into an attempt at which the satellite count is checked.' },
          { key: 'ublox_min_fix_time', label: 'Minimum fix time', control: 'duration', unit: 's', help: 'Shortest time the receiver keeps refining a fix.' },
          { key: 'ublox_leave_on', label: 'Receiver stays on after a fix', control: 'duration', unit: 's', help: 'How long the receiver stays on after a fix completes.' },
          { key: 'gps_backoff_factor', label: 'Backoff after failed fix', help: 'Delay applied to the next fix after an unsuccessful attempt.' },
          { key: 'ublox_cold_fix_hour_interval', label: 'Cold fix allowed every', control: 'duration', unit: 'h', zeroMeansOff: true, help: 'Minimum time between cold fix attempts. 0 allows a cold fix whenever needed.' },
          { key: 'gps_init_lat', label: 'Initial latitude', control: 'coordinate', help: 'Starting position used before the first fix.' },
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
