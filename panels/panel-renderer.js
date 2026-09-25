// Renders guided settings panels from panel definitions. The panel is a view over the
// same state as the settings list: it reads effective values through the host and
// writes through the host, which routes into the list inputs, so validation, the
// pending draft and "Review and apply" are shared. No global names are leaked; the
// API is exported on window.PanelRenderer.
(function () {
  'use strict';

  const engine = window.PanelEngine;
  let mounted = null; // { container, definitions, host, updaters: [], fieldElements: Map }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function slug(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function isFocused(node) {
    return node && document.activeElement === node;
  }

  function fieldLabel(field, host) {
    if (field.label) return field.label;
    const key = engine.fieldKeys(field)[0];
    return key ? host.getLabel(key) : '';
  }

  function fieldHelp(field, host) {
    if (field.help !== undefined) return field.help;
    if (field.control === 'mode' || field.control === 'choice') return '';
    const key = engine.fieldKeys(field)[0];
    return key ? host.getDescription(key) : '';
  }

  function gateReason(condition, host, explicit) {
    if (explicit) return explicit;
    const keys = Array.from(engine.conditionKeys(condition));
    if (!keys.length) return 'Not available with the current settings.';
    const labels = keys.map(key => {
      const setting = host.getSetting(key);
      return setting ? host.getLabel(key) : key;
    });
    return `Only used with: ${labels.join(', ')}.`;
  }

  // ---- controls -------------------------------------------------------------------

  function makeNumberControl(field, setting, host) {
    const input = el('input', 'panel-input');
    input.type = 'number';
    input.step = setting.conversion === 'float' ? '0.01' : '1';
    if (setting.min !== undefined) input.min = setting.min;
    if (setting.max !== undefined) input.max = setting.max;
    input.addEventListener('input', () => host.setValue(field.key, input.value.trim()));
    const wrap = el('div', 'panel-control panel-control-number');
    wrap.appendChild(input);
    if (field.unit) wrap.appendChild(el('span', 'panel-unit', field.unit));
    return {
      node: wrap,
      focusable: input,
      update(value) { if (!isFocused(input)) input.value = value ?? ''; },
      setDisabled(disabled) { input.disabled = disabled; },
    };
  }

  const DURATION_UNITS = {
    s: [{ value: 1, label: 'seconds' }, { value: 60, label: 'minutes' }, { value: 3600, label: 'hours' }, { value: 86400, label: 'days' }],
    h: [{ value: 1, label: 'hours' }, { value: 24, label: 'days' }],
  };

  function guessUnit(units, raw) {
    const value = engine.toNumber(raw);
    if (!Number.isFinite(value) || value <= 0) return units[0].value;
    for (let i = units.length - 1; i >= 0; i -= 1) {
      if (value % units[i].value === 0) return units[i].value;
    }
    return units[0].value;
  }

  function makeDurationControl(field, setting, host) {
    const units = DURATION_UNITS[field.unit] || DURATION_UNITS.s;
    const input = el('input', 'panel-input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    const select = el('select', 'panel-select');
    units.forEach(unit => {
      const option = el('option', null, unit.label);
      option.value = String(unit.value);
      select.appendChild(option);
    });
    let unitValue = units[0].value;
    const commit = () => {
      const count = Math.max(0, Number(input.value) || 0);
      host.setValue(field.key, String(Math.round(count * unitValue)));
    };
    input.addEventListener('input', commit);
    select.addEventListener('change', () => {
      unitValue = Number(select.value);
      commit();
    });
    const wrap = el('div', 'panel-control panel-control-duration');
    wrap.appendChild(input);
    wrap.appendChild(select);
    const hint = field.zeroMeansOff ? el('span', 'panel-hint', '0 = off') : null;
    if (hint) wrap.appendChild(hint);
    return {
      node: wrap,
      focusable: input,
      update(value) {
        if (isFocused(input) || isFocused(select)) return;
        const raw = engine.toNumber(value);
        unitValue = guessUnit(units, raw);
        select.value = String(unitValue);
        input.value = Number.isFinite(raw) ? String(raw / unitValue) : '';
        if (hint) hint.classList.toggle('panel-hint-active', raw === 0);
      },
      setDisabled(disabled) { input.disabled = disabled; select.disabled = disabled; },
    };
  }

  function makeUtcHourControl(field, setting, host) {
    const input = el('input', 'panel-input panel-input-hour');
    input.type = 'number';
    input.min = '0';
    input.max = '23';
    input.step = '1';
    input.addEventListener('input', () => {
      const hour = Math.max(0, Math.min(23, Math.trunc(Number(input.value) || 0)));
      host.setValue(field.key, String(hour));
    });
    const local = el('span', 'panel-hint', '');
    const wrap = el('div', 'panel-control panel-control-hour');
    wrap.appendChild(input);
    wrap.appendChild(el('span', 'panel-unit', 'h UTC'));
    wrap.appendChild(local);
    return {
      node: wrap,
      focusable: input,
      update(value) {
        if (!isFocused(input)) input.value = value ?? '';
        const localTime = host.formatLocalTime ? host.formatLocalTime(value) : null;
        local.textContent = localTime ? `= ${localTime} local` : '';
      },
      setDisabled(disabled) { input.disabled = disabled; },
    };
  }

  function makeToggleControl(field, setting, host) {
    const label = el('label', 'panel-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => host.setValue(field.key, input.checked ? 'true' : 'false'));
    const knob = el('span', 'panel-toggle-knob');
    const text = el('span', 'panel-toggle-text', '');
    label.appendChild(input);
    label.appendChild(knob);
    label.appendChild(text);
    return {
      node: label,
      focusable: input,
      update(value) {
        const on = engine.toBool(value);
        input.checked = on;
        text.textContent = on ? 'On' : 'Off';
      },
      setDisabled(disabled) { input.disabled = disabled; },
    };
  }

  function makeCoordinateControl(field, setting, host) {
    const input = el('input', 'panel-input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = 'decimal degrees';
    input.addEventListener('input', () => {
      const degrees = Number(input.value.replace(',', '.'));
      if (Number.isFinite(degrees)) {
        host.setValue(field.key, String(Math.round(degrees * 1e7)));
      }
    });
    const wrap = el('div', 'panel-control');
    wrap.appendChild(input);
    wrap.appendChild(el('span', 'panel-unit', 'degrees'));
    return {
      node: wrap,
      focusable: input,
      update(value) {
        if (isFocused(input)) return;
        const raw = engine.toNumber(value);
        input.value = Number.isFinite(raw) ? (raw / 1e7).toFixed(7) : '';
      },
      setDisabled(disabled) { input.disabled = disabled; },
    };
  }

  function makeTextControl(field, setting, host) {
    const input = el('input', 'panel-input panel-input-mono');
    input.type = 'text';
    input.addEventListener('input', () => host.setValue(field.key, input.value.trim()));
    const wrap = el('div', 'panel-control');
    wrap.appendChild(input);
    return {
      node: wrap,
      focusable: input,
      update(value) { if (!isFocused(input)) input.value = value ?? ''; },
      setDisabled(disabled) { input.disabled = disabled; },
    };
  }

  function makeOptionsControl(field, host, name) {
    const wrap = el('div', 'panel-options');
    const inputs = [];
    (field.options || []).forEach(option => {
      const label = el('label', 'panel-option');
      const input = el('input');
      input.type = 'radio';
      input.name = name;
      input.value = option.id;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        engine.optionWrites(option, host.getValue).forEach(write => host.setValue(write.key, String(write.value)));
      });
      const body = el('span', 'panel-option-body');
      body.appendChild(el('span', 'panel-option-title', option.label));
      if (option.help) body.appendChild(el('span', 'panel-option-help', option.help));
      label.appendChild(input);
      label.appendChild(body);
      wrap.appendChild(label);
      inputs.push({ input, option, label });
    });
    return {
      node: wrap,
      focusable: inputs[0] ? inputs[0].input : null,
      update() {
        const current = engine.resolveOption(field, host.getValue);
        inputs.forEach(({ input, option, label }) => {
          input.checked = Boolean(current && current.id === option.id);
          label.classList.toggle('selected', input.checked);
        });
      },
      setDisabled(disabled) { inputs.forEach(({ input }) => { input.disabled = disabled; }); },
    };
  }

  function makeControl(field, setting, host, name) {
    switch (field.control) {
      case 'mode':
      case 'choice':
        return makeOptionsControl(field, host, name);
      case 'duration':
        return makeDurationControl(field, setting, host);
      case 'utc-hour':
        return makeUtcHourControl(field, setting, host);
      case 'toggle':
        return makeToggleControl(field, setting, host);
      case 'coordinate':
        return makeCoordinateControl(field, setting, host);
      case 'bytes':
        return makeTextControl(field, setting, host);
      default:
        if (setting && setting.conversion === 'bool') return makeToggleControl(field, setting, host);
        if (setting && ['uint32', 'uint16', 'uint8', 'int32', 'int8', 'float'].includes(setting.conversion)) {
          return makeNumberControl(field, setting, host);
        }
        return makeTextControl(field, setting, host);
    }
  }

  // ---- fields -----------------------------------------------------------------------

  function renderField(field, panel, host, inherited, state, inheritedReason) {
    const keys = engine.fieldKeys(field);
    const primarySetting = keys.length ? host.getSetting(keys[0]) : null;
    if (keys.length && keys.some(key => !host.getSetting(key))) {
      return null; // not in this firmware's schema
    }
    const row = el('div', `panel-field panel-field-${field.control || 'value'}`);
    row.dataset.keys = keys.join(' ');
    const head = el('div', 'panel-field-head');
    const label = el('label', 'panel-field-label', fieldLabel(field, host));
    head.appendChild(label);
    const badge = el('span', 'panel-field-badge', 'changed');
    head.appendChild(badge);
    row.appendChild(head);
    const control = makeControl(field, primarySetting, host, `${panel.id}-${slug(fieldLabel(field, host))}`);
    if (control.focusable && keys.length === 1) {
      const id = `panel-${panel.id}-${slug(keys[0])}`;
      control.focusable.id = id;
      label.htmlFor = id;
    }
    row.appendChild(control.node);
    const help = fieldHelp(field, host);
    if (help) row.appendChild(el('div', 'panel-field-help', help));
    const reason = el('div', 'panel-field-reason', '');
    row.appendChild(reason);
    const error = el('div', 'panel-field-error', '');
    row.appendChild(error);

    const enabledWhen = mergeConditions(inherited, field.enabledWhen);
    const explicitReason = field.reason || inheritedReason || null;
    const updater = () => {
      const visible = engine.evaluateCondition(field.visibleWhen, host.getValue);
      row.classList.toggle('hidden', !visible);
      if (!visible) return;
      const enabled = engine.evaluateCondition(enabledWhen, host.getValue);
      control.setDisabled(!enabled);
      row.classList.toggle('panel-field-disabled', !enabled);
      reason.textContent = enabled ? '' : gateReason(enabledWhen, host, explicitReason);
      if (keys.length === 1) {
        control.update(host.getValue(keys[0]));
        const value = host.getValue(keys[0]);
        error.textContent = host.validate ? host.validate(keys[0], value) : '';
      } else {
        control.update();
      }
      badge.classList.toggle('visible', keys.some(key => host.isPending(key)));
    };
    state.updaters.push(updater);
    keys.forEach(key => state.fieldElements.set(key, row));
    return row;
  }

  function mergeConditions(...conditions) {
    const present = conditions.filter(condition => condition !== undefined && condition !== null);
    if (!present.length) return null;
    return present.length === 1 ? present[0] : { all: present };
  }

  function renderFields(fields, panel, host, inherited, state, inheritedReason = null) {
    const fragment = document.createDocumentFragment();
    (fields || []).forEach(field => {
      if (Array.isArray(field.fields)) {
        const group = el('details', `panel-group${field.advanced ? ' panel-group-advanced' : ''}`);
        group.open = !field.advanced;
        const summary = el('summary', 'panel-group-title', field.group);
        group.appendChild(summary);
        if (field.help) group.appendChild(el('p', 'panel-group-help', field.help));
        const inner = el('div', 'panel-fields');
        inner.appendChild(renderFields(field.fields, panel, host, mergeConditions(inherited, field.enabledWhen), state, field.reason || inheritedReason));
        group.appendChild(inner);
        if (inner.children.length) fragment.appendChild(group);
        return;
      }
      const row = renderField(field, panel, host, inherited, state, inheritedReason);
      if (row) fragment.appendChild(row);
    });
    return fragment;
  }

  // ---- panel ------------------------------------------------------------------------

  function renderPositioningExtras(panel, host, state, body) {
    const summary = el('p', 'panel-summary', '');
    const bar = el('div', 'panel-daybar hidden');
    const track = el('div', 'panel-daybar-track');
    bar.appendChild(track);
    const labels = el('div', 'panel-daybar-labels');
    ['00', '06', '12', '18', '24'].forEach(text => labels.appendChild(el('span', null, text)));
    bar.appendChild(labels);
    const legend = el('div', 'panel-daybar-legend', '');
    bar.appendChild(legend);
    body.appendChild(summary);
    body.appendChild(bar);
    state.updaters.push(() => {
      summary.textContent = engine.describePositioning(host.getValue, {
        localTime: hour => (host.formatLocalTime ? host.formatLocalTime(hour) : null),
      });
      const multiple = host.getSetting('ublox_multiple_intervals') && engine.toBool(host.getValue('ublox_multiple_intervals'));
      bar.classList.toggle('hidden', !multiple);
      if (!multiple) return;
      track.innerHTML = '';
      const start1 = host.getValue('ublox_interval1_start');
      const start2 = host.getValue('ublox_interval2_start');
      engine.daySegments(start1, start2).forEach(segment => {
        const seg = el('div', 'panel-daybar-seg');
        seg.style.left = `${segment.left}%`;
        seg.style.width = `${segment.width}%`;
        track.appendChild(seg);
      });
      const d1 = engine.formatDurationWords(host.getValue('ublox_send_interval'));
      const d2 = engine.formatDurationWords(host.getValue('ublox_send_interval_2'));
      legend.textContent = `Shaded: ${engine.formatUtcHour(start1)} to ${engine.formatUtcHour(start2)} UTC, every ${d1}. Unshaded: every ${d2}.`;
    });
  }

  function renderPanel(panel, host, state) {
    const card = el('details', 'section section-card panel-card');
    card.id = `panel-${panel.id}`;
    card.open = true;
    const title = el('summary', 'section-card-title');
    const icon = el('span', 'icon location-dot');
    icon.setAttribute('aria-hidden', 'true');
    title.appendChild(icon);
    title.appendChild(document.createTextNode(panel.title));
    card.appendChild(title);
    const body = el('div', 'section-card-body panel-body');
    if (panel.description) body.appendChild(el('p', 'panel-description', panel.description));
    if (panel.summary === 'positioning') renderPositioningExtras(panel, host, state, body);
    const fields = el('div', 'panel-fields');
    fields.appendChild(renderFields(panel.fields, panel, host, null, state));
    body.appendChild(fields);
    card.appendChild(body);
    return fields.children.length ? card : null;
  }

  function mount(container, definitions, host) {
    container.innerHTML = '';
    const state = { container, host, updaters: [], fieldElements: new Map() };
    const panels = Array.isArray(definitions) ? definitions : (definitions && definitions.panels) || [];
    panels.forEach(panel => {
      const card = renderPanel(panel, host, state);
      if (card) container.appendChild(card);
    });
    mounted = state;
    refresh();
    return container.children.length;
  }

  function refresh() {
    if (!mounted) return;
    mounted.updaters.forEach(update => update());
  }

  function unmount() {
    if (mounted) mounted.container.innerHTML = '';
    mounted = null;
  }

  // The field element that edits a setting key, if a mounted panel has one.
  function locate(key) {
    return mounted ? mounted.fieldElements.get(key) || null : null;
  }

  window.PanelRenderer = { mount, refresh, unmount, locate };
}());
