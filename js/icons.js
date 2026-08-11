/**
 * STRUCTA V3 structural icon system.
 *
 * Crisp, local SVG geometry replaces the old photographic 64px rasters. The
 * paths remain available through the original numeric and semantic slots so
 * existing renderers and offline installs keep working without extra requests.
 */
(() => {
  'use strict';

  function svgData(body) {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">' + body + '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
  }

  const ICONS = Object.freeze({
    brand: svgData(
      '<path fill="#080808" d="M10 50h10V21l12-7 12 7v12h10V15L32 2 10 15z"/>' +
      '<path fill="#080808" d="M28 30h8v22h18v10H28z"/>'
    ),
    brandLight: svgData(
      '<path fill="#f4efe4" d="M10 50h10V21l12-7 12 7v12h10V15L32 2 10 15z"/>' +
      '<path fill="#f4efe4" d="M28 30h8v22h18v10H28z"/>'
    ),
    show: svgData(
      '<path fill="#080808" d="M6 6h21v9H15v12H6zM37 6h21v21h-9V15H37zM6 37h9v12h12v9H6zM49 37h9v21H37v-9h12z"/>'
    ),
    tell: svgData(
      '<path fill="#080808" d="M32 6a26 26 0 1 0 0 52 26 26 0 0 0 20-9l-11-8a13 13 0 1 1 4-9H32z"/>'
    ),
    know: svgData(
      '<path fill="#080808" d="M7 10h22v19H7zM35 35h22v19H35zM23 23h18v8H23zM27 27h8v14h-8z"/>'
    ),
    now: svgData(
      '<path fill="#080808" d="M8 8h31l17 24-17 24H8l15-24zm18 18-4 6 4 6h12l5-6-5-6z"/>'
    )
  });

  const BY_ID = Object.freeze({
    '3': ICONS.tell,
    '4': ICONS.show,
    '5': ICONS.brand,
    '6': ICONS.now,
    '7': ICONS.know
  });

  const SLOTS = Object.freeze({
    'brand-app': ICONS.brand,
    'brand-mark': ICONS.brandLight,
    'card-show': ICONS.show,
    'card-tell': ICONS.tell,
    'card-know': ICONS.know,
    'card-now': ICONS.now,
    'touch-hint': 'assets/icons/svg/touch.svg'
  });

  window.StructaIcons = Object.freeze({
    byId: BY_ID,
    slots: SLOTS,
    get: function(name) {
      return SLOTS[name] || BY_ID[name] || '';
    }
  });
  window.StructaIconSlots = SLOTS;
})();
