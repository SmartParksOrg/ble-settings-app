const HW_TYPES = {
  byId: {
    0: { label: 'default', fileName: 'default' },
    1: { label: 'rhinoedge', fileName: 'rhinoedge_nrf52840' },
    2: { label: 'elephantedge', fileName: 'elephantedge_nrf52840' },
    3: { label: 'wisentedge', fileName: 'wisentedge_nrf52840' },
    4: { label: 'cattracker', fileName: 'cattracker_nrf52840' },
    5: { label: 'rangeredge', fileName: 'rangeredge_nrf52840' },
    6: { label: 'rhinopuck', fileName: 'rhinopuck_nrf52840' },
    7: { label: 'freeedge', fileName: 'freeedge_nrf52840' },
    8: { label: 'collaredge', fileName: 'collaredge_nrf52840' },
    9: { label: 'rhinopuck35', fileName: 'rhinopuck35_nrf52840' },
  },
};

const HW_DFU_MANIFEST_URL = 'assets/dfu/manifest.json';
let cachedManifest = null;
let cachedHwVersionsByType = null;

function normalizeHwTypeName(name) {
  if (name === 'rangeredge_airq_nrf52840') {
    return 'rangeredge_nrf52840';
  }
  return name;
}

function getHwTypeLabel(hwType) {
  if (Number.isFinite(hwType) && HW_TYPES.byId[hwType]) {
    return HW_TYPES.byId[hwType].label;
  }
  return 'unknown';
}

function getHwTypeFileName(hwType) {
  if (Number.isFinite(hwType) && HW_TYPES.byId[hwType]) {
    return HW_TYPES.byId[hwType].fileName;
  }
  return undefined;
}

async function loadDfuManifest() {
  if (cachedManifest) {
    return cachedManifest;
  }
  const response = await fetch(HW_DFU_MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Manifest fetch failed: ${response.status}`);
  }
  cachedManifest = await response.json();
  return cachedManifest;
}

function buildHwVersionsByType(manifest) {
  const map = new Map();
  const releases = Array.isArray(manifest?.releases) ? manifest.releases : [];
  releases.forEach((release) => {
    const files = Array.isArray(release?.files) ? release.files : [];
    files.forEach((file) => {
      if (!file?.hwType || !file?.hwVersion) {
        return;
      }
      const normalizedHwType = normalizeHwTypeName(file.hwType);
      if (!map.has(normalizedHwType)) {
        map.set(normalizedHwType, new Set());
      }
      map.get(normalizedHwType).add(file.hwVersion);
    });
  });
  return map;
}

async function getValidHwVersionsByType() {
  if (cachedHwVersionsByType) {
    return cachedHwVersionsByType;
  }
  const manifest = await loadDfuManifest();
  cachedHwVersionsByType = buildHwVersionsByType(manifest);
  return cachedHwVersionsByType;
}

async function getValidHwVersionsForHwType(hwTypeOrName) {
  const hwTypeName = Number.isFinite(hwTypeOrName) ? getHwTypeFileName(hwTypeOrName) : hwTypeOrName;
  if (!hwTypeName) {
    return [];
  }
  const map = await getValidHwVersionsByType();
  const versions = Array.from(map.get(hwTypeName) || []);
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions;
}

window.HW_TYPES = HW_TYPES;
window.getHwTypeLabel = getHwTypeLabel;
window.getHwTypeFileName = getHwTypeFileName;
window.loadDfuManifest = loadDfuManifest;
window.getValidHwVersionsByType = getValidHwVersionsByType;
window.getValidHwVersionsForHwType = getValidHwVersionsForHwType;
