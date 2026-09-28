'use strict';

(function (root) {
  const devices = Object.freeze([
    'CB-01', 'CB-02', 'CB-03', 'CB-04', 'CB-05', 'CB-06',
    'CB-07', 'CB-08', 'CB-09', 'CB-10', 'CB-11', 'CB-12'
  ]);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = devices;
  } else {
    root.ALL_DEVICES = devices;
  }
})(typeof window !== 'undefined' ? window : globalThis);
