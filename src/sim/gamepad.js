import { clamp, neutral } from './flight.js';

export const padBindings = [
  { key: 'yaw', name: '偏航', instruction: '左搖桿向右', sign: 1 },
  { key: 'throttle', name: '油門', instruction: '左搖桿向上', sign: -1 },
  { key: 'roll', name: '滾轉', instruction: '右搖桿向右', sign: 1 },
  { key: 'pitch', name: '俯仰', instruction: '右搖桿向上', sign: -1 },
];

export function padInstruction(slot, mode) {
  if (mode === 1 && slot === 1) return '右搖桿向上';
  if (mode === 1 && slot === 3) return '左搖桿向上';
  return padBindings[slot].instruction;
}

export function touchAxis(side, mode) {
  return side === 'left' ? { x: 'yaw', y: mode === 1 ? 'pitch' : 'throttle' } :
    { x: 'roll', y: mode === 1 ? 'throttle' : 'pitch' };
}

export function padValues(profile, axes) {
  const input = neutral();
  if (!profile) return input;
  for (const [slot, { key, sign }] of padBindings.entries()) {
    const value = axes[profile.axes[slot]];
    if (!Number.isFinite(value)) continue;
    const center = profile.centers[slot] ?? 0;
    const offset = value - center;
    const bound = offset > 0 ? 1 - center : 1 + center;
    const normalized = clamp(offset / Math.max(.25, bound), -1, 1);
    const deadzone = profile.deadzone ?? .08;
    const magnitude = Math.max(0, (Math.abs(normalized) - deadzone) / (1 - deadzone));
    if (magnitude === 0) continue;
    input[key] = sign * (profile.reverse[slot] ? -1 : 1) * Math.sign(normalized) * magnitude;
  }
  return input;
}

export function startPadCalibration(axes) {
  return { baseline: [...axes], axes: [], centers: [], reverse: [], returning: false, done: false, error: '' };
}

export function updatePadCalibration(calibration, axes) {
  if (calibration.done || calibration.error) return;
  if (calibration.returning) {
    if (calibration.axes.every(axis => Math.abs(axes[axis] - calibration.baseline[axis]) < .20)) {
      calibration.returning = false;
      calibration.done = calibration.axes.length === padBindings.length;
    }
    return;
  }
  let candidate = -1;
  let strongest = .44;
  axes.forEach((value, axis) => {
    const change = Math.abs(value - calibration.baseline[axis]);
    if (change > strongest && !calibration.axes.includes(axis)) {
      strongest = change;
      candidate = axis;
    }
  });
  if (candidate < 0) return;
  const center = calibration.baseline[candidate];
  if (Math.abs(center) > .85) {
    calibration.error = '這個搖桿的起始位置接近端點。請把油門也移到行程中間，再重新開始。';
    return;
  }
  const slot = calibration.axes.length;
  calibration.axes.push(candidate);
  calibration.centers.push(center);
  calibration.reverse.push(Math.sign(axes[candidate] - center) !== padBindings[slot].sign);
  calibration.returning = true;
}
