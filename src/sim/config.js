export const STEP = 1 / 120;
export const TEAM_NAMES = ['紅隊', '藍隊'];
export const ROLE_NAMES = {
  striker: '得分手', support: '支援', left: '左翼支援', right: '右翼支援',
  sweeper: '清道夫', defender: '防守',
};
export const rolesFor = size => size === 5 ?
  ['striker', 'left', 'right', 'sweeper', 'defender'] : ['striker', 'support', 'defender'];

export const field = Object.freeze({ length: 6, width: 3, height: 3 });
export const goalSize = Object.freeze({ inner: .2, outer: .35, halfDepth: .05 });
export const radius = .10;

export const profiles = Object.freeze({
  'fai-f9ab-2026': { name: 'F9A-B 手動規則練習', teamSize: 3, ...field, setSeconds: 180, breakSeconds: 120, manual: true },
  'course-3v3': { name: '課程 3v3', teamSize: 3, ...field, setSeconds: 180, breakSeconds: 120, manual: false },
  'course-5v5': { name: '課程 5v5', teamSize: 5, ...field, setSeconds: 180, breakSeconds: 120, manual: false },
});
export const traceConfig = Object.freeze({ sampleRate: 10, strikerRate: 30, before: 8, after: 2, maxSeconds: 1000 });
export const controlDefaults = Object.freeze({
  sensitivity: 1, tilt: 34, thrust: 1, damping: 1, bounce: .34,
  stabilize: true, quality: 'medium', shake: true, volume: .55, effects: .8, muted: false, sound: 'horn',
  stickMode: 2, deadzone: .08, axes: [0, 1, 2, 3], reverse: [false, false, false, false],
  centers: [0, 0, 0, 0], keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
});
export const courseDefaults = Object.freeze({ pass: 92, collisionPenalty: 2, timeScale: 1, hints: true });

export const goalAt = (x, direction = Math.sign(x), y = 2, z = 0) =>
  ({ id: 'goal:' + [x, y, z, direction].join(','), x, y, z, direction, ...goalSize });
export const standardGoals = length => [goalAt(1 - length / 2, -1), goalAt(length / 2 - 1, 1)];

export const firstPilotKeys = controlDefaults.keys;
export const secondPilotKeys = ['KeyI', 'KeyK', 'KeyJ', 'KeyL', 'KeyU', 'KeyO', 'KeyY', 'KeyP'];
export const secondPilotActions = { KeyM: 'arm', KeyN: 'stop', KeyB: 'turtle' };
export const secondPilotId = 'pilot-2';
