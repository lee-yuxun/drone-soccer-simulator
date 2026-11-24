import { clamp, neutral } from './flight.js';
import { padValues, startPadCalibration, updatePadCalibration } from './gamepad.js';

export const $ = id => document.getElementById(id);
export function make(tag, text = '', attrs = {}) {
  const node = document.createElement(tag);
  node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}
export function button(text, run, attrs) {
  const node = make('button', text, { type: 'button', ...attrs });
  node.addEventListener('click', run);
  return node;
}
export function store(key, data) {
  try { localStorage.setItem('drone-soccer:' + key, JSON.stringify(data)); return true; } catch { return false; }
}
export function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem('drone-soccer:' + key)) ?? fallback; } catch { return fallback; }
}
export function download(name, content, type) {
  const url = typeof content === 'string' && content.startsWith('data:') ? content :
    URL.createObjectURL(new Blob([content], { type }));
  const link = make('a', '', { href: url, download: name });
  link.click();
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 500);
}
export const csv = rows => '\uFEFF' + rows.map(row => row.map(value =>
  '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n');
export const labelKeys = ['升高', '下降', '左偏航', '右偏航', '前進', '後退', '左平移', '右平移'];
export const humanKey = key => ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' })[key] ??
  key.replace(/^Key|^Digit/, '');

export function makeInput(settings, action, save) {
  const held = new Set();
  let awaiting;
  let detecting;
  let calibration;
  let devices = [];
  let padError = '';
  let currentPad = null;
  let preferredPad;
  let previousButtons = [];
  let labels = null;
  const virtual = neutral();
  const profiles = settings.padProfiles ??= {};
  const legacyMapping = settings.axes.join(',') !== '0,1,2,3' || settings.reverse.some(Boolean) ||
    settings.centers.some(center => center !== 0);
  const deviceKey = pad => pad.index + ':' + pad.id;
  const profileKey = pad => 'device:' + pad.id;
  const legacyProfile = () => Object.fromEntries(['axes', 'centers', 'reverse', 'deadzone'].map(key =>
    [key, Array.isArray(settings[key]) ? [...settings[key]] : settings[key]]));
  const savedProfile = () => currentPad ? profiles[profileKey(currentPad)] : undefined;
  const activeProfile = () => {
    if (!currentPad) return;
    const profile = savedProfile() ?? (currentPad.mapping === 'standard' || legacyMapping ? settings : undefined);
    if (profile && profile.axes.length === 4 && new Set(profile.axes).size === 4 &&
        profile.axes.every(axis => Number.isInteger(axis) && axis >= 0 && axis < currentPad.axes.length)) return profile;
  };
  function editProfile() {
    const profile = savedProfile() ?? legacyProfile();
    return { ...profile, axes: [...profile.axes], centers: [...profile.centers], reverse: [...profile.reverse] };
  }
  function saveProfile(profile) {
    if (!currentPad) return false;
    profiles[profileKey(currentPad)] = profile;
    save();
    return true;
  }
  function bindStick(element, horizontal, vertical) {
    let pointer;
    const shift = event => {
      if (event.pointerId !== pointer) return;
      const bounds = element.getBoundingClientRect();
      const travel = bounds.width * .32;
      virtual[horizontal] = clamp((event.clientX - bounds.left - bounds.width / 2) / travel, -1, 1);
      virtual[vertical] = clamp((bounds.top + bounds.height / 2 - event.clientY) / travel, -1, 1);
    };
    const reset = () => {
      const released = pointer;
      pointer = undefined;
      virtual[horizontal] = 0;
      virtual[vertical] = 0;
      element.removeAttribute('data-held');
      if (released != null && element.hasPointerCapture(released)) element.releasePointerCapture(released);
    };
    const release = event => { if (event.pointerId === pointer) reset(); };
    element.addEventListener('pointerdown', event => {
      if (pointer != null || event.button !== 0) return;
      event.preventDefault();
      pointer = event.pointerId;
      element.setPointerCapture(pointer);
      element.setAttribute('data-held', '');
      shift(event);
    });
    element.addEventListener('pointermove', shift);
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
    return reset;
  }
  const resetLeft = bindStick($('left-pocket'), 'yaw', 'throttle');
  const resetRight = bindStick($('right-pocket'), 'roll', 'pitch');
  const clearVirtual = () => { resetLeft(); resetRight(); };
  const shortcuts = { Space: 'arm', KeyT: 'turtle', KeyZ: 'reset', Escape: 'pause', KeyC: 'camera', KeyX: 'stop' };
  const formFocused = event => /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable;
  const clear = () => { held.clear(); clearVirtual(); };
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', clear);
  document.addEventListener('keyup', event => held.delete(event.code));
  document.addEventListener('keydown', event => {
    if (awaiting) {
      event.preventDefault();
      const { index, node } = awaiting;
      awaiting = undefined;
      if (event.code !== 'Escape' && !shortcuts[event.code]) {
        const duplicate = settings.keys.indexOf(event.code);
        if (duplicate !== -1) settings.keys[duplicate] = settings.keys[index];
        settings.keys[index] = event.code;
        save();
      }
      labels?.forEach((label, i) => { label.textContent = humanKey(settings.keys[i]); });
      node.blur();
      return;
    }
    if (document.querySelector('dialog[open]') || formFocused(event) ||
        (event.code === 'Space' && event.target.tagName === 'BUTTON')) return;
    const shortcut = shortcuts[event.code];
    if (!shortcut && !settings.keys.includes(event.code)) return;
    event.preventDefault();
    if (shortcut) {
      if (!event.repeat) action(shortcut);
      return;
    }
    held.add(event.code);
  });
  function keyboard() {
    const active = index => Number(held.has(settings.keys[index]));
    return { throttle: active(0) - active(1), yaw: active(3) - active(2),
      pitch: active(4) - active(5), roll: active(7) - active(6) };
  }
  function updateController() {
    try {
      if (typeof navigator.getGamepads !== 'function') {
        padError = window.isSecureContext ? '目前瀏覽器未提供遊戲控制器介面。' : '請使用 HTTPS 的公開版偵測遙控器。';
        devices = [];
      } else {
        padError = '';
        devices = Array.from(navigator.getGamepads()).filter(pad => pad && pad.connected !== false && pad.axes.length);
      }
    } catch {
      devices = [];
      padError = '目前頁面無法讀取手把。請直接用手機或平板瀏覽器開啟 HTTPS 公開版。';
    }
    const next = preferredPad ?
      devices.find(pad => deviceKey(pad) === preferredPad.key) ?? devices.find(pad => pad.id === preferredPad.id) :
      devices.find(pad => pad.axes.length >= 4) ?? devices[0];
    const changed = (currentPad ? deviceKey(currentPad) : '') !== (next ? deviceKey(next) : '');
    currentPad = next ?? null;
    if (currentPad && !preferredPad) preferredPad = { key: deviceKey(currentPad), id: currentPad.id };
    if (!changed) return false;
    detecting = undefined;
    if (calibration && !calibration.done) {
      calibration.error = '控制器已切換或斷線，請重新開始校正。';
    }
    return true;
  }

  function poll(blocked) {
    const changed = updateController();
    if (currentPad && calibration && !calibration.done && !calibration.error) {
      updatePadCalibration(calibration, currentPad.axes);
      if (calibration.done) {
        const { axes, centers, reverse } = calibration;
        saveProfile({ axes: [...axes], centers: [...centers], reverse: [...reverse],
          deadzone: activeProfile()?.deadzone ?? settings.deadzone });
      }
    }
    if (detecting && currentPad) {
      const { axis, baseline, onDetect } = detecting;
      const deltas = currentPad.axes.map((value, index) => Math.abs(value - baseline[index]));
      const candidate = deltas.indexOf(Math.max(...deltas));
      if (candidate >= 0 && deltas[candidate] > .5) {
        const profile = savedProfile() ?? legacyProfile();
        profile.axes[axis] = candidate;
        profile.centers[axis] = 0;
        detecting = undefined;
        saveProfile(profile);
        onDetect(candidate);
      }
    }
    const states = [0, 1, 3].map(index => Boolean(currentPad?.buttons[index]?.pressed));
    if (!blocked && !changed && currentPad?.mapping === 'standard') {
      for (const [index, name] of ['arm', 'turtle', 'stop'].entries()) {
        if (states[index] && !previousButtons[index]) action(name);
      }
    }
    previousButtons = states;
    if (blocked) return neutral();
    const keys = keyboard();
    const physical = padValues(activeProfile(), currentPad?.axes ?? []);
    return Object.fromEntries(Object.keys(keys).map(axis => [axis, keys[axis] || virtual[axis] || physical[axis]]));
  }
  return {
    poll, clear, clearVirtual,
    get pad() { return currentPad; },
    get padError() { return padError; },
    get profile() { return activeProfile(); },
    get calibration() { return calibration; },
    get devices() { return devices.map(pad => ({ key: deviceKey(pad), id: pad.id, index: pad.index })); },
    get selectedKey() { return currentPad ? deviceKey(currentPad) : ''; },
    choosePad(key) {
      const device = devices.find(pad => deviceKey(pad) === key);
      preferredPad = device ? { key, id: device.id } : undefined;
      detecting = undefined;
      calibration = undefined;
    },
    startCalibration() {
      if (!currentPad || currentPad.axes.length < 4) return false;
      detecting = undefined;
      calibration = startPadCalibration(currentPad.axes);
      return true;
    },
    cancelCalibration() { calibration = undefined; },
    detect(axis, onDetect) {
      if (!currentPad) return false;
      calibration = undefined;
      detecting = { axis, baseline: [...currentPad.axes], onDetect };
      return true;
    },
    cancel() { awaiting = undefined; detecting = undefined; calibration = undefined; },
    editProfile,
    saveProfile,
    center() {
      if (!currentPad) return false;
      const profile = editProfile();
      profile.centers = profile.axes.map(axis => currentPad.axes[axis] ?? 0);
      return saveProfile(profile);
    },
    clearProfile() {
      if (!currentPad) return;
      delete profiles[profileKey(currentPad)];
      save();
    },
    keyButtons(container) {
      labels = [];
      container.replaceChildren(...labelKeys.map((text, index) => {
        const rebind = button(humanKey(settings.keys[index]), () => {
          labels.forEach((label, i) => { label.textContent = humanKey(settings.keys[i]); });
          awaiting = { index, node: rebind };
          rebind.textContent = '按下新按鍵';
        });
        labels.push(rebind);
        const label = make('label', text);
        label.append(rebind);
        return label;
      }));
    },
  };
}

export function makeAudio(settings) {
  let context;
  let last = '';
  function enable() {
    if (settings.muted) return;
    const Audio = window.AudioContext ?? window.webkitAudioContext;
    if (!Audio) return;
    context ??= new Audio();
    if (context.state === 'suspended') context.resume().catch(() => {});
  }
  function note(frequency, delay, duration, kind, level) {
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = kind;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0001, settings.volume * settings.effects * level), start + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + .01);
  }
  function sound(type, id) {
    if (!context || settings.muted || (id && id === last)) return;
    if (id) last = id;
    if (type === 'goal') {
      const style = settings.sound;
      const notes = style === 'electronic' ? [392, 587, 784, 1174] : style === 'cheer' ?
        [392, 440, 523, 659, 784, 698] : [261.63, 392, 523.25];
      for (const [i, frequency] of notes.entries()) {
        note(frequency, i * (style === 'cheer' ? .075 : .11), .22,
          style === 'electronic' ? 'sine' : 'triangle', style === 'cheer' ? .09 : .17);
      }
    } else if (type === 'start') {
      note(988, 0, .35, 'sine', .24);
    } else if (type === 'penalty') {
      note(760, 0, .17, 'triangle', .21); note(760, .22, .25, 'triangle', .21);
    } else if (type === 'finished' || type === 'setEnd') {
      note(440, 0, .23, 'triangle', .22); note(type === 'finished' ? 660 : 330, .25, .4, 'triangle', .22);
    }
  }
  return { enable, sound };
}
