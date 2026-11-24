import { clamp, neutral } from './flight.js';

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
  let currentPad = null;
  let previousButtons = [false, false, false];
  let labels = null;
  let virtual = neutral();
  function bindStick(element, horizontal, vertical) {
    let pointer;
    const shift = event => {
      if (event.pointerId !== pointer) return;
      const bounds = element.getBoundingClientRect();
      const travel = bounds.width * .32;
      virtual[horizontal] = clamp((event.clientX - bounds.left - bounds.width / 2) / travel, -1, 1);
      virtual[vertical] = clamp((bounds.top + bounds.height / 2 - event.clientY) / travel, -1, 1);
    };
    const release = event => {
      if (event.pointerId !== pointer) return;
      pointer = undefined;
      virtual[horizontal] = 0;
      virtual[vertical] = 0;
    };
    element.addEventListener('pointerdown', event => {
      if (pointer != null || event.button !== 0) return;
      event.preventDefault();
      pointer = event.pointerId;
      element.setPointerCapture(pointer);
      shift(event);
    });
    element.addEventListener('pointermove', shift);
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
  }
  bindStick($('left-pocket'), 'yaw', 'throttle');
  bindStick($('right-pocket'), 'roll', 'pitch');
  const shortcuts = { Space: 'arm', KeyT: 'turtle', KeyZ: 'reset', Escape: 'pause', KeyC: 'camera', KeyX: 'stop' };
  const formFocused = event => /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable;
  const clear = () => { held.clear(); virtual = neutral(); };
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
  function poll(blocked) {
    currentPad = [...(navigator.getGamepads?.() ?? [])].find(Boolean) ?? null;
    if (detecting && currentPad) {
      const candidate = currentPad.axes.findIndex((axis, i) => Math.abs(axis - (detecting.baseline[i] ?? 0)) > .5);
      if (candidate >= 0) {
        settings.axes[detecting.axis] = candidate;
        detecting.onDetect(candidate);
        detecting = undefined;
        save();
      }
    }
    if (blocked) return neutral();
    const keyValues = keyboard();
    const keys = Object.fromEntries(Object.keys(keyValues).map(axis => [axis, keyValues[axis] || virtual[axis]]));
    if (!currentPad) return keys;
    const states = [0, 1, 3].map(index => Boolean(currentPad.buttons[index]?.pressed));
    for (const [index, name] of ['arm', 'turtle', 'stop'].entries()) {
      if (states[index] && !previousButtons[index]) action(name);
    }
    previousButtons = states;
    const calibrated = settings.axes.map((axis, index) => {
      const value = currentPad.axes[axis] ?? 0;
      const center = settings.centers[index] ?? 0;
      const offset = value - center;
      const normalized = clamp(offset / Math.max(.25, offset > 0 ? 1 - center : 1 + center), -1, 1);
      const amount = Math.max(0, (Math.abs(normalized) - settings.deadzone) / (1 - settings.deadzone));
      return Math.sign(normalized) * amount * (settings.reverse[index] ? -1 : 1);
    });
    const [yaw, throttle, roll, pitch] = calibrated;
    return { throttle: keys.throttle || -throttle, yaw: keys.yaw || yaw,
      pitch: keys.pitch || -pitch, roll: keys.roll || roll };
  }
  return {
    poll, clear, get pad() { return currentPad; },
    detect(axis, onDetect) {
      if (!currentPad) return false;
      detecting = { axis, baseline: [...currentPad.axes], onDetect };
      return true;
    },
    cancel() { awaiting = undefined; detecting = undefined; },
    center() {
      if (!currentPad) return false;
      settings.centers = settings.axes.map(axis => currentPad.axes[axis] ?? 0);
      save();
      return true;
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
