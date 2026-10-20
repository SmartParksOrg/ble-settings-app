// Device type icons, taken from the Smart Parks Connect mobile app
// (https://github.com/SmartParksOrg/smartparks-connect-app, src/assets/*Icon.tsx,
// Copyright (C) 2021 Vid Rajtmajer <vid@irnas.eu>, Irnas d.o.o., GPL-3.0), so the web app
// shows the same animal for a collar as the phone app does. The strokes use currentColor so
// CSS decides the colour.
//
// The Connect app picks the icon by firmware type when the firmware reports one (a ranger
// board running elephant firmware shows the elephant) and by hardware type otherwise;
// getDeviceIconKey follows that. Hardware/firmware type numbers are the ones in
// hardware-types.js: 1 rhino, 2 elephant, 3 wisent, 4 cat, 5 ranger, 6 rhinopuck,
// 7 rhinopuck35, 8 collaredge, 9 freeedge (collaredgefree).
(function () {
  const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="1.5" aria-hidden="true" focusable="false">${body}</svg>`;

  const DEVICE_ICONS = {
    cat: svg('0 0 40 40',
      '<path d="M10.41 9l-1.22.56-.74 1-.32.76a.71.71 0 000 .29 8 8 0 010 1.46c-.09.17-.34.44-.44.6a.44.44 0 00-.08.25v.19a.81.81 0 00.21.6l1.02 1.19a.58.58 0 00.29.17l1 .22h2.12M10.6 5.51l2.93 4.73c.12 0 .9-2.38.59-2.73a37.13 37.13 0 00-3.52-2s-.29 2.9.23 3.8.91 1.06.91 1.06"/>'
      + '<path d="M10.47 7.6c0-.4-3.32-1-3.32-1A18.18 18.18 0 019 9.85M34.55 11.09c-7.59.22-11.79 1.82-11.79 1.82l-4 .16c-2.55-4.14-3.61-4.68-4.38-4.54"/>'
      + '<path d="M14 31.85c2.39-1.58 5.48-5.63 5.48-7.78M12.24 16.3l1 .33A3.08 3.08 0 0114.71 19v4.69a22.64 22.64 0 01-5 8.32"/>'
      + '<path d="M30 31.51c-.39-3.57-1.09-9.88-2.73-10.58M27.1 31.33c-.62-1.79-2.42-6.14-5.66-6.77-4.09-.8-4-3.33-4-3.33M27.36 34.55H26.3M34.55 24.36c-2.47-.1-5.67-.5-5.67-.5M27.1 31.33"/>'
      + '<path d="M26.3 34.55h1.06s1.45-1.8 2.61-3M27.1 31.33a8 8 0 01-1.1 1.26l-2.15.46s-1.27 1.5-.56 1.5h3"/>'
      + '<path d="M14 31.85a27.59 27.59 0 01-4 2.82H6.35c-.7 0 .56-1.51.56-1.51l2.15-.45c.08-.13.63-.75.73-.86"/>'),
    elephant: svg('0 0 36.21 28.24',
      '<g transform="translate(.02)">'
      + '<path d="M24.61 20.05c5 1.78 7.89 1.65 11.11-.94M14.94 15.77a14.47 14.47 0 004.9 3.23M6.12 16.46a10.79 10.79 0 01-.8 7.94l1.14.75C8.85 23 8.35 16 8.35 16M35.91 2.8l-2.08-.3s-4.91 1.83-9.22.5L19.8 1.24C16 .3 9 .22 8.21 5.48c0 0-2.34 2.83-2.79 4.69a9.57 9.57 0 00.38 5.06"/>'
      + '<path d="M18.81 1s3.64 1.9 3.64 5.11c-.29 3.34-2.93 3.15-3.45 3.54l-1.35 1.56c-.74.89-.64 2.77-3.41 5.25l-.65-.64c-1.18-1.18-1.41-4.11-.75-6.66a1.8 1.8 0 00-.55-1.55l-.12-2.74"/>'
      + '<path d="M12.76 13.59C7.46 18.73.81 15.21.81 15.21l.06-.36S5.33 17.42 11 12.23M24.73 27.89l.56-1.59s-1.52-6.92 0-11.61M20.3 13.34c-1.18 2.87-.09 6.8-.09 6.8.48 4-.51 5.66-.51 5.66l-1.13 2M17.38 17.7a7.11 7.11 0 00-.14 2.64 14.89 14.89 0 01-.34 5.6l-1.24 1.88"/>'
      + '</g>'),
    ranger: svg('0 0 40 40',
      '<path d="M11.34 12.61s1.3-5.53 2.5-7.56 15.32.93 15.9 2.8.26 6.15-.29 7.87c0 0 6.28 6.27 6.28 6.52s-.7 2.3-8 1.31c0 0-9.16-2.39-10.89-4.11a3 3 0 00-3.28-.68 8.71 8.71 0 01-9.25-2.7s-.34-1.21 2.2-1.21c-.03 0 3.49-2.09 4.83-2.24z"/>'
      + '<path d="M11.34 12.61A10.61 10.61 0 0017.08 14a11.35 11.35 0 015.09 1.73s4.24 1.11 7.28 0M13.88 5S20 8.17 29.74 7.85M16.12 33.81c-.41-3.23-.93-3-.93-3a6.53 6.53 0 01-1.62.27l-1.38.06H12c-2.2.12-1.37-3.15-1.37-3.15l-.53-.91.8-.32-.9-.68.27-.56s.53-1 0-1-1.49-1-1.49-1A40.5 40.5 0 0011.16 20a2.46 2.46 0 00-.11-.48M27.15 33.49a31 31 0 01-.68-6.26 18.81 18.81 0 011.67-3.52"/>'
      + '<path d="M19.32 20.53S16 30.76 12.43 33.43l-.25-2.3M12.43 33.43L11.76 36"/>'
      + '<circle cx="12.43" cy="33.43" r="0.37"/>'),
    rhino: svg('0 0 36.4 22.8',
      '<path d="M31.66 15.01l-.04 7.66M28.25 22.67l.34-4.15-.6-2.01M18.35 12.85a9.12 9.12 0 002 6.7l-.54 3.12M36.24 1.29C28.34 3 23.82.77 23.82.77l-8.18 1.12-6.79 3.58a3.07 3.07 0 01-1.07 2.88L5 5.83h-.26v3l-3.29-3H.78c.25 6.33 3.57 7.8 3.57 7.8v2.42a10.32 10.32 0 005.62 0 7.51 7.51 0 005.16-4.67M36.23 17.89a12.61 12.61 0 01-4.57-.58M14.24 13.05l4.04 1.51"/>'),
    wisent: svg('0 0 32.86 29.6',
      '<g transform="translate(.01)">'
      + '<path d="M18.51 29.2l2.77-4a1.31 1.31 0 01.22-.2l2-1.79a1.29 1.29 0 01.69-.34l8.53-1.54M7.82 7.91a2.45 2.45 0 00-2-.08 27.15 27.15 0 00-4.64 4.82 2.43 2.43 0 00-.43 1.61c0 .48 1.34 2.21 2.09 3.14a1.44 1.44 0 01.24 1.34 1.41 1.41 0 00.32 1.44l.18.18a1.42 1.42 0 00.86.43l.88.1a1.42 1.42 0 011.21 1L6.86 23a1.4 1.4 0 00.65.82l1.7 1-.33-2 .75-.82 6.79 1.69a1.42 1.42 0 011.07 1.23v.16a1.43 1.43 0 01-.27 1L14.9 29.2M32.45 3.33S22.9-.57 18 1.22a1.29 1.29 0 00-.33.17l-5.12 3.48a1.38 1.38 0 00-.55.71 4 4 0 01-2 2.33"/>'
      + '<path d="M10 7.9a43.61 43.61 0 00-3.54-3.78h-.14s1.73 2.47 1.46 4.09A16.21 16.21 0 007.32 10a1.78 1.78 0 001.45 1.83c.9.21 2-.34 2-2.15A3.09 3.09 0 0010 7.9zM26.7 22.35l-2.55 3a1.58 1.58 0 00-.31.62l-.66 3.2"/>'
      + '</g>'),
    // No type known yet (or an unknown type): a plain collar outline.
    collar: svg('0 0 40 40',
      '<path d="M8 14.5c0-5 5.4-8.5 12-8.5s12 3.5 12 8.5v11c0 5-5.4 8.5-12 8.5S8 30.5 8 25.5z"/>'
      + '<path d="M8 14.5c0 5 5.4 8.5 12 8.5s12-3.5 12-8.5"/>'
      + '<rect x="16.5" y="24" width="7" height="6" rx="1.5"/>'),
  };

  // Type number (hardware or firmware) to icon key, as in the Connect app's renderIcon.
  const ICON_BY_TYPE = {
    1: 'rhino', 2: 'elephant', 3: 'wisent', 4: 'cat', 5: 'ranger',
    6: 'rhino', 7: 'rhino', 8: 'cat', 9: 'cat',
  };

  const TYPE_NAMES = {
    1: 'Rhino', 2: 'Elephant', 3: 'Wisent', 4: 'Cat', 5: 'Ranger',
    6: 'Rhino puck', 7: 'Rhino puck 35', 8: 'Collar', 9: 'Free',
  };

  function getDeviceIconKey(hwType, fwType) {
    const fw = Number(fwType);
    if (Number.isFinite(fw) && ICON_BY_TYPE[fw]) {
      return ICON_BY_TYPE[fw];
    }
    const hw = Number(hwType);
    if (Number.isFinite(hw) && ICON_BY_TYPE[hw]) {
      return ICON_BY_TYPE[hw];
    }
    return 'collar';
  }

  function getDeviceIconSvg(key) {
    return DEVICE_ICONS[key] || DEVICE_ICONS.collar;
  }

  // Human name for the animal the icon shows, used in the device card's label.
  function getDeviceTypeName(hwType, fwType) {
    const fw = Number(fwType);
    if (Number.isFinite(fw) && TYPE_NAMES[fw]) {
      return TYPE_NAMES[fw];
    }
    const hw = Number(hwType);
    if (Number.isFinite(hw) && TYPE_NAMES[hw]) {
      return TYPE_NAMES[hw];
    }
    return '';
  }

  window.DEVICE_ICONS = DEVICE_ICONS;
  window.getDeviceIconKey = getDeviceIconKey;
  window.getDeviceIconSvg = getDeviceIconSvg;
  window.getDeviceTypeName = getDeviceTypeName;
}());
