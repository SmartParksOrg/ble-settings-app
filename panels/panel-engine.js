// Panel engine: a draft of pending setting changes, condition evaluation for
// panel definitions, dependency-aware write ordering, and an apply runner that
// writes each setting and reads it back. Pure logic, no DOM: loaded as a classic
// script in the browser (window.PanelEngine) and required directly in Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PanelEngine = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function toBool(value) {
    if (value === true || value === false) return value;
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim().toLowerCase();
    if (text === '' || text === 'false' || text === '0' || text === 'off' || text === 'no') return false;
    if (text === 'true' || text === 'on' || text === 'yes') return true;
    const number = Number(text);
    return Number.isFinite(number) ? number !== 0 : true;
  }

  function toNumber(value) {
    if (typeof value === 'number') return value;
    if (value === true) return 1;
    if (value === false) return 0;
    const number = Number(String(value ?? '').trim());
    return Number.isFinite(number) ? number : NaN;
  }

  function sameValue(actual, expected) {
    if (typeof expected === 'boolean') return toBool(actual) === expected;
    if (typeof expected === 'number') return toNumber(actual) === expected;
    return String(actual ?? '') === String(expected ?? '');
  }

  // Condition forms: true/false, { key, equals | notEquals | in | truthy | gt | gte | lt | lte },
  // { all: [...] }, { any: [...] }, { not: condition }. getValue(key) returns the effective value.
  function evaluateCondition(condition, getValue) {
    if (condition === null || condition === undefined) return true;
    if (typeof condition === 'boolean') return condition;
    if (Array.isArray(condition.all)) return condition.all.every(item => evaluateCondition(item, getValue));
    if (Array.isArray(condition.any)) return condition.any.some(item => evaluateCondition(item, getValue));
    if (condition.not !== undefined) return !evaluateCondition(condition.not, getValue);
    if (!condition.key) return true;
    const value = getValue(condition.key);
    if ('equals' in condition) return sameValue(value, condition.equals);
    if ('notEquals' in condition) return !sameValue(value, condition.notEquals);
    if (Array.isArray(condition.in)) return condition.in.some(candidate => sameValue(value, candidate));
    if ('truthy' in condition) return toBool(value) === Boolean(condition.truthy);
    if ('gt' in condition) return toNumber(value) > condition.gt;
    if ('gte' in condition) return toNumber(value) >= condition.gte;
    if ('lt' in condition) return toNumber(value) < condition.lt;
    if ('lte' in condition) return toNumber(value) <= condition.lte;
    return true;
  }

  function conditionKeys(condition, into = new Set()) {
    if (!condition || typeof condition !== 'object') return into;
    if (condition.key) into.add(condition.key);
    (condition.all || []).forEach(item => conditionKeys(item, into));
    (condition.any || []).forEach(item => conditionKeys(item, into));
    if (condition.not) conditionKeys(condition.not, into);
    return into;
  }

  // Walk a panel definition's fields, including nested groups, yielding leaf fields.
  function walkFields(fields, visit, context = {}) {
    (fields || []).forEach(field => {
      if (Array.isArray(field.fields)) {
        walkFields(field.fields, visit, { group: field, inherited: mergeConditions(context.inherited, field.enabledWhen, field.visibleWhen) });
        return;
      }
      visit(field, context);
    });
  }

  function mergeConditions(...conditions) {
    const present = conditions.filter(condition => condition !== undefined && condition !== null);
    if (!present.length) return null;
    return present.length === 1 ? present[0] : { all: present };
  }

  function fieldKeys(field) {
    if (Array.isArray(field.keys)) return field.keys.slice();
    return field.key ? [field.key] : [];
  }

  // For each setting key: the keys that gate it (from enabledWhen/visibleWhen, including
  // enclosing groups) and the keys it must be written after.
  function collectFieldRules(definitions) {
    const rules = new Map();
    const ensure = key => {
      if (!rules.has(key)) rules.set(key, { gates: new Set(), writeAfter: new Set() });
      return rules.get(key);
    };
    const panels = Array.isArray(definitions) ? definitions : (definitions && definitions.panels) || [];
    panels.forEach(panel => {
      walkFields(panel.fields, (field, context) => {
        const gating = conditionKeys(mergeConditions(context.inherited, field.enabledWhen, field.visibleWhen));
        fieldKeys(field).forEach(key => {
          const rule = ensure(key);
          gating.forEach(gate => { if (gate !== key) rule.gates.add(gate); });
          (field.writeAfter || []).forEach(after => { if (after !== key) rule.writeAfter.add(after); });
        });
      });
    });
    return rules;
  }

  // Order changes so that dependents are written before a gate that turns on, and after a
  // gate that turns off, plus any explicit writeAfter. Stable for unrelated keys. Falls back
  // to the given order if the constraints form a cycle.
  function planWriteOrder(changes, definitions) {
    const list = (changes || []).map((change, index) => ({ ...change, __index: index }));
    const rules = collectFieldRules(definitions);
    const byKey = new Map(list.map(change => [change.key, change]));
    const precedes = new Map(list.map(change => [change.key, new Set()])); // key -> keys that must come before it
    list.forEach(change => {
      const rule = rules.get(change.key);
      if (!rule) return;
      rule.gates.forEach(gate => {
        if (!byKey.has(gate)) return;
        if (toBool(byKey.get(gate).value)) {
          precedes.get(gate).add(change.key); // dependent first, then the gate that enables it
        } else {
          precedes.get(change.key).add(gate); // gate off first, then the dependent
        }
      });
      rule.writeAfter.forEach(after => {
        if (byKey.has(after)) precedes.get(change.key).add(after);
      });
    });
    const remaining = new Set(list.map(change => change.key));
    const ordered = [];
    while (remaining.size) {
      const ready = list
        .filter(change => remaining.has(change.key))
        .filter(change => Array.from(precedes.get(change.key)).every(dep => !remaining.has(dep)));
      if (!ready.length) {
        return list.map(({ __index, ...change }) => change); // cycle: keep the original order
      }
      ready.sort((a, b) => a.__index - b.__index);
      const next = ready[0];
      remaining.delete(next.key);
      ordered.push(next);
    }
    return ordered.map(({ __index, ...change }) => change);
  }

  function createDraft() {
    const entries = new Map();
    const listeners = new Set();
    const draft = {
      set(key, entry) {
        entries.set(key, { ...(entries.get(key) || {}), ...entry, key });
        notify();
      },
      clear(key) {
        if (entries.delete(key)) notify();
      },
      reset() {
        if (!entries.size) return;
        entries.clear();
        notify();
      },
      get(key) { return entries.get(key) || null; },
      has(key) { return entries.has(key); },
      get size() { return entries.size; },
      keys() { return Array.from(entries.keys()); },
      entries() { return Array.from(entries.values()); },
      invalidCount() { return Array.from(entries.values()).filter(entry => entry.valid === false).length; },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    function notify() { listeners.forEach(listener => listener(draft)); }
    return draft;
  }

  // Write each item, then read it back and compare. Statuses: verified, mismatch,
  // unverified (no read-back available), failed (write or read threw).
  async function runApply({ items, write, read, isEqual, onItem, settleMs = 150 }) {
    const summary = { total: items.length, verified: 0, mismatch: 0, unverified: 0, failed: 0, results: [] };
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let status = 'failed';
      let readValue = null;
      let error = null;
      try {
        await write(item);
        if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
        if (typeof read === 'function') {
          readValue = await read(item);
          if (readValue === null || readValue === undefined) {
            status = 'unverified';
          } else {
            status = isEqual(item, readValue) ? 'verified' : 'mismatch';
          }
        } else {
          status = 'unverified';
        }
      } catch (caught) {
        error = caught;
        status = 'failed';
      }
      summary[status] += 1;
      summary.results.push({ item, status, readValue, error });
      if (typeof onItem === 'function') {
        await onItem({ index, item, status, readValue, error });
      }
    }
    return summary;
  }

  // Which option of a mode/choice field matches the effective values; null when none does.
  function resolveOption(field, getValue) {
    const options = Array.isArray(field.options) ? field.options : [];
    return options.find(option => evaluateCondition(option.when, getValue)) || null;
  }

  // Values to write when an option is chosen: its `set` values, plus `ensure` values for
  // keys whose current value is empty or zero (so "Fixed interval" never leaves 0 = off).
  function optionWrites(option, getValue) {
    const writes = [];
    Object.entries(option.set || {}).forEach(([key, value]) => writes.push({ key, value }));
    Object.entries(option.ensure || {}).forEach(([key, value]) => {
      const current = getValue(key);
      const number = toNumber(current);
      if (current === null || current === undefined || String(current).trim() === '' || number === 0) {
        writes.push({ key, value });
      }
    });
    return writes;
  }

  // A "switch" field turns a feature on or off by writing several settings.
  //   { control: 'switch', keys, on: <condition>, turnOff: { key: value }, turnOn: { ensure: { key: value } } }
  // Turning off writes turnOff. Turning on restores the values remembered when it was
  // turned off (for the turnOff keys), then applies turnOn.ensure where a value is still
  // empty or zero.
  function isSwitchOn(field, getValue) {
    return evaluateCondition(field.on, getValue);
  }

  function switchWrites(field, turnOn, getValue, remembered) {
    if (!turnOn) {
      return Object.entries(field.turnOff || {}).map(([key, value]) => ({ key, value }));
    }
    const writes = [];
    const restored = {};
    Object.keys(field.turnOff || {}).forEach(key => {
      const previous = remembered ? remembered[key] : undefined;
      if (previous !== undefined && previous !== null && String(previous) !== '') {
        writes.push({ key, value: previous });
        restored[key] = previous;
      }
    });
    const ensure = (field.turnOn && field.turnOn.ensure) || {};
    Object.entries(ensure).forEach(([key, value]) => {
      const current = key in restored ? restored[key] : getValue(key);
      const number = toNumber(current);
      if (current === null || current === undefined || String(current).trim() === '' || number === 0 || current === false || current === 'false') {
        if (!(key in restored) || number === 0) {
          writes.push({ key, value });
        }
      }
    });
    return writes;
  }

  function formatDurationWords(totalSeconds) {
    const seconds = Math.round(toNumber(totalSeconds));
    if (!Number.isFinite(seconds) || seconds <= 0) return 'off';
    const units = [
      { size: 86400, singular: 'day', plural: 'days' },
      { size: 3600, singular: 'hour', plural: 'hours' },
      { size: 60, singular: 'minute', plural: 'minutes' },
      { size: 1, singular: 'second', plural: 'seconds' },
    ];
    const parts = [];
    let remaining = seconds;
    units.forEach(unit => {
      const count = Math.floor(remaining / unit.size);
      if (count > 0 && parts.length < 2) {
        parts.push(`${count} ${count === 1 ? unit.singular : unit.plural}`);
        remaining -= count * unit.size;
      }
    });
    return parts.join(' ');
  }

  function formatUtcHour(hour) {
    const value = Math.max(0, Math.min(23, Math.trunc(toNumber(hour)) || 0));
    return `${String(value).padStart(2, '0')}:00`;
  }

  // Segments (in percent of a 24 h bar) covered by the day window [start1, start2).
  function daySegments(start1, start2) {
    const a = Math.max(0, Math.min(23, Math.trunc(toNumber(start1)) || 0));
    const b = Math.max(0, Math.min(23, Math.trunc(toNumber(start2)) || 0));
    if (a === b) return [{ left: 0, width: 100 }];
    if (a < b) return [{ left: (a / 24) * 100, width: ((b - a) / 24) * 100 }];
    return [
      { left: (a / 24) * 100, width: ((24 - a) / 24) * 100 },
      { left: 0, width: (b / 24) * 100 },
    ];
  }

  // One or two plain sentences describing the positioning behaviour.
  // fmt.localTime(hour) may return a local clock time for a UTC hour, or null.
  function describePositioning(getValue, fmt = {}) {
    const has = key => getValue(key) !== null && getValue(key) !== undefined;
    const num = key => toNumber(getValue(key));
    const bool = key => toBool(getValue(key));
    const duration = fmt.duration || formatDurationWords;
    const hourLabel = hour => {
      const utc = `${formatUtcHour(hour)} UTC`;
      const local = fmt.localTime ? fmt.localTime(hour) : null;
      return local ? `${utc} (${local} local)` : utc;
    };
    const sentences = [];
    const multiple = has('ublox_multiple_intervals') && bool('ublox_multiple_intervals');
    const interval1 = has('ublox_send_interval') ? num('ublox_send_interval') : 0;
    const interval2 = has('ublox_send_interval_2') ? num('ublox_send_interval_2') : 0;
    const outdoorOn = has('outdoor_detection_enabled') && bool('outdoor_detection_enabled');
    const motionOn = has('enable_motion_trig_gps') && bool('enable_motion_trig_gps');
    if (multiple) {
      const first = interval1 > 0 ? `every ${duration(interval1)}` : 'no fixes';
      const second = interval2 > 0 ? `every ${duration(interval2)}` : 'no fixes';
      sentences.push(`Fix ${first} from ${hourLabel(getValue('ublox_interval1_start'))} to ${hourLabel(getValue('ublox_interval2_start'))}, and ${second} the rest of the day.`);
    } else if (interval1 > 0) {
      sentences.push(`Fix every ${duration(interval1)}, all day.`);
    } else {
      sentences.push('Scheduled fixes are off.');
      if (outdoorOn || motionOn) {
        sentences.push('Motion-triggered and outdoor detection have no effect while scheduled fixes are off.');
      }
      if (has('gps_resend_interval') && num('gps_resend_interval') > 0) {
        sentences.push(`The last position is resent every ${duration(num('gps_resend_interval'))}.`);
      }
      return sentences.join(' ');
    }
    if (outdoorOn) {
      sentences.push('Fixes are only attempted when the tracker is probably outdoors.');
    }
    if (motionOn) {
      const windowSeconds = has('gps_triggered_interval') ? num('gps_triggered_interval') : 0;
      const needed = has('gps_motion_triggered_min_num_of_triggers_per_interval') ? num('gps_motion_triggered_min_num_of_triggers_per_interval') : 0;
      if (windowSeconds > 0 && needed > 0) {
        sentences.push(`An extra fix is taken after ${needed} movement${needed === 1 ? '' : 's'} within ${duration(windowSeconds)}.`);
      } else {
        const skips = has('gps_skipped_triggered_interval') ? num('gps_skipped_triggered_interval') : 0;
        sentences.push(skips > 0
          ? `While the tracker is still, up to ${skips} scheduled fix${skips === 1 ? ' is' : 'es are'} skipped.`
          : 'While the tracker is still, scheduled fixes are still taken.');
      }
    }
    if (has('ublox_active_tracking') && bool('ublox_active_tracking')) {
      sentences.push('The receiver stays on between fixes and reports heading and speed.');
    }
    if (has('gps_resend_interval') && num('gps_resend_interval') > 0) {
      sentences.push(`The last position is resent every ${duration(num('gps_resend_interval'))}.`);
    }
    return sentences.join(' ');
  }

  // One or two sentences about how a fix attempt runs, from the fix-quality settings.
  function describeFixQuality(getValue, fmt = {}) {
    const has = key => getValue(key) !== null && getValue(key) !== undefined;
    const num = key => toNumber(getValue(key));
    const duration = fmt.duration || formatDurationWords;
    const sentences = [];
    if (has('cold_fix_timeout') || has('cold_fix_retry')) {
      const parts = [];
      if (has('cold_fix_timeout')) parts.push(`up to ${duration(num('cold_fix_timeout'))} per attempt`);
      if (has('cold_fix_retry')) parts.push(`${num('cold_fix_retry')} attempt${num('cold_fix_retry') === 1 ? '' : 's'}`);
      sentences.push(`Cold fix: ${parts.join(', ')}.`);
    }
    if (has('hot_fix_timeout') || has('hot_fix_retry')) {
      const parts = [];
      if (has('hot_fix_timeout')) parts.push(`up to ${duration(num('hot_fix_timeout'))} per attempt`);
      if (has('hot_fix_retry')) parts.push(`${num('hot_fix_retry')} attempt${num('hot_fix_retry') === 1 ? '' : 's'}`);
      sentences.push(`Hot fix: ${parts.join(', ')}.`);
    }
    if (has('ublox_min_satellites')) {
      const minimum = num('ublox_min_satellites');
      if (minimum > 0) {
        const after = has('ublox_min_satellites_timer') ? ` after ${duration(num('ublox_min_satellites_timer'))}` : '';
        sentences.push(`An attempt is abandoned${after} if fewer than ${minimum} satellites are visible.`);
      } else {
        sentences.push('Attempts are not abandoned early for too few satellites.');
      }
    }
    if (has('horizontal_accuracy')) {
      sentences.push(`Accuracy target ${num('horizontal_accuracy')} m.`);
    }
    return sentences.join(' ');
  }

  function optionLabel(fmt, key, value) {
    const options = fmt.options ? fmt.options(key) : null;
    if (Array.isArray(options)) {
      const match = options.find(option => String(option.value) === String(value));
      if (match) return match.label;
    }
    return value === null || value === undefined ? null : String(value);
  }

  function describeNetwork(getValue, fmt = {}) {
    const has = key => getValue(key) !== null && getValue(key) !== undefined;
    const duration = fmt.duration || formatDurationWords;
    const sentences = [];
    if (has('lr_region')) sentences.push(`Region ${optionLabel(fmt, 'lr_region', getValue('lr_region'))}.`);
    if (has('lr_adr_profile')) {
      const profile = toNumber(getValue('lr_adr_profile'));
      const label = optionLabel(fmt, 'lr_adr_profile', getValue('lr_adr_profile'));
      sentences.push(profile === 3 && has('lr_adr')
        ? `Adaptive data rate: custom, DR${toNumber(getValue('lr_adr'))}.`
        : `Adaptive data rate: ${label}.`);
    }
    if (has('rejoin_interval')) sentences.push(`Rejoin attempts every ${duration(toNumber(getValue('rejoin_interval')))}.`);
    return sentences.join(' ');
  }

  function describeDevice(getValue, fmt = {}) {
    const has = key => getValue(key) !== null && getValue(key) !== undefined;
    const duration = fmt.duration || formatDurationWords;
    const sentences = [];
    if (has('device_name') && String(getValue('device_name')).trim()) sentences.push(`${String(getValue('device_name')).trim()}.`);
    if (has('device_pin')) {
      const digits = fmt.pinDigits ? fmt.pinDigits(getValue('device_pin')) : '';
      sentences.push(digits && digits !== '0000' ? 'Bluetooth PIN set.' : 'No Bluetooth PIN.');
    }
    if (has('led_enabled')) sentences.push(toBool(getValue('led_enabled')) ? 'Status LED on.' : 'Status LED off.');
    if (has('status_send_interval')) sentences.push(`Status report every ${duration(toNumber(getValue('status_send_interval')))}.`);
    return sentences.join(' ');
  }

  function portBit(portNumber) {
    return (1 << (portNumber - 1)) >>> 0;
  }

  function isPortSet(mask, portNumber) {
    return ((toNumber(mask) >>> 0) & portBit(portNumber)) !== 0;
  }

  function setPort(mask, portNumber, on) {
    const current = toNumber(mask) >>> 0;
    return (on ? (current | portBit(portNumber)) : (current & ~portBit(portNumber))) >>> 0;
  }

  // ports: [{ name, number, label }]; columns: [{ key, label }]
  function describeDataFlags(getValue, ports, columns) {
    const parts = [];
    (columns || []).forEach(column => {
      const mask = getValue(column.key);
      if (mask === null || mask === undefined) return;
      const count = (ports || []).filter(port => isPortSet(mask, port.number)).length;
      parts.push(`${count} ${column.summaryLabel || column.label.toLowerCase()}`);
    });
    if (!parts.length) return '';
    return `Of ${(ports || []).length} message types: ${parts.join(', ')}.`;
  }

  return {
    toBool,
    toNumber,
    evaluateCondition,
    conditionKeys,
    walkFields,
    fieldKeys,
    collectFieldRules,
    planWriteOrder,
    createDraft,
    runApply,
    resolveOption,
    optionWrites,
    isSwitchOn,
    switchWrites,
    formatDurationWords,
    formatUtcHour,
    daySegments,
    describePositioning,
    describeFixQuality,
    describeNetwork,
    describeDevice,
    describeDataFlags,
    portBit,
    isPortSet,
    setPort,
  };
}));
