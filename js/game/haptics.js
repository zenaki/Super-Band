// Getar kecil. Android: Vibration API. iPhone tidak punya Vibration API, jadi dipakai trik
// iOS 18+: men-toggle <input type="checkbox" switch> lewat label memicu haptic bawaan sistem.

let label = null;

function iosSwitch() {
  if (label) return label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.id = 'haptic-switch';
  label = document.createElement('label');
  label.htmlFor = input.id;
  for (const el of [input, label]) {
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  }
  document.body.append(input, label);
  return label;
}

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export function tapHaptic() {
  try {
    if (canVibrate) navigator.vibrate(8);
    else iosSwitch().click();
  } catch (err) {
    /* device tidak mendukung */
  }
}

export function missHaptic() {
  try {
    if (canVibrate) navigator.vibrate(18);
  } catch (err) {
    /* device tidak mendukung */
  }
}
