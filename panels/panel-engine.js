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
  };
}));
