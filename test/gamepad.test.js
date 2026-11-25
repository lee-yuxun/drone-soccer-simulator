import assert from 'node:assert/strict';
import test from 'node:test';
import { neutral } from '../src/sim/flight.js';
import { padInstruction, padValues, startPadCalibration, touchAxis, updatePadCalibration } from '../src/sim/gamepad.js';

test('ELRS Mode 2 calibration detects nonstandard axis order, centers and direction', () => {
  const center = [.04, -.03, .08, -.07, 1, -1];
  const calibration = startPadCalibration(center);
  for (const [axis, value] of [[3, -.82], [2, .9], [0, .82], [1, -.9]]) {
    const movement = [...center];
    movement[axis] = value;
    updatePadCalibration(calibration, movement);
    assert.equal(calibration.returning, true);
    updatePadCalibration(calibration, movement);
    assert.equal(calibration.returning, true);
    updatePadCalibration(calibration, center);
    assert.equal(calibration.returning, false);
  }
  assert.equal(calibration.done, true);
  assert.deepEqual(calibration.axes, [3, 2, 0, 1]);
  assert.deepEqual(calibration.reverse, [true, true, false, false]);
  assert.deepEqual(padValues(calibration, center), neutral());
  assert.deepEqual(padValues(calibration, [1, -1, 1, -1]), { yaw: 1, throttle: 1, roll: 1, pitch: 1 });
  assert.deepEqual(padValues(calibration, []), neutral());
});

test('calibration detects non-centering throttle at its endpoint', () => {
  const calibration = startPadCalibration([0, 0, -1, 0]);
  updatePadCalibration(calibration, [0, 0, .1, 0]);
  assert.match(calibration.error, /行程中間/);
  assert.equal(calibration.axes.length, 0);
});

test('Mode 1 moves throttle to the right stick without changing yaw or roll', () => {
  assert.deepEqual(touchAxis('left', 2), { x: 'yaw', y: 'throttle' });
  assert.deepEqual(touchAxis('right', 2), { x: 'roll', y: 'pitch' });
  assert.deepEqual(touchAxis('left', 1), { x: 'yaw', y: 'pitch' });
  assert.deepEqual(touchAxis('right', 1), { x: 'roll', y: 'throttle' });
  assert.equal(padInstruction(1, 1), '右搖桿向上');
  assert.equal(padInstruction(3, 1), '左搖桿向上');
});
