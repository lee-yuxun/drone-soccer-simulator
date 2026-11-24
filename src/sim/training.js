import { field, goalAt, radius } from './config.js';
import { angleDelta, clamp, distance, point } from './flight.js';

const at = (x, y, z, extra) => ({ type: 'point', p: point(x, y, z), radius: .29, ...extra });
const hold = (x, y, z, seconds, yaw) => at(x, y, z, { type: 'hold', seconds, yaw, radius: .23 });
const land = (x, z, tolerance = .25) => at(x, radius, z, { type: 'land', radius: tolerance });
const face = (x, y, z, yaw) => at(x, y, z, { yaw });
const spin = (direction, x, y, z) => at(x, y, z, { type: 'spin', direction, radius: .32 });
const gate = goal => at(goal.x, goal.y, goal.z, { type: 'goal', gate: goal.id, radius: .11 });
const cone = (x, z) => point(x, 0, z);
const home = at(-.7, 1.3, 0, { type: 'home', radius: .57 });
const resetHeading = face(2.8, 2, 0, Math.PI);
const gateNarrow = goalAt(2);
const gateFar = goalAt(3);
const wide = { length: 12, width: 8, height: 5.5 };
const medium = { length: 10, width: 6.5, height: 3.5 };
const circle = direction => Array.from({ length: 13 }, (_, i) => {
  const t = direction * i * Math.PI / 6;
  return face(2.5 * Math.cos(t), 1.4, 2.5 * Math.sin(t), Math.atan2(direction * Math.cos(t), -direction * Math.sin(t)));
});
const uprightEight = follow => Array.from({ length: 33 }, (_, i) => {
  const t = i * Math.PI / 8;
  const y = 2.72 + 2 * Math.sin(t);
  const z = 1.95 * Math.sin(2 * t);
  return face(.4, y, z, follow ? (Math.cos(2 * t) < 0 ? -Math.PI / 2 : Math.PI / 2) : 0);
});
const slalomCones = [cone(-3, 0), cone(0, 0), cone(3, 0)];
const slalom = [at(-3, 1, -.85), at(0, 1, .85), at(3, 1, -.85)];
const drill = (title, help, start, stages, options = {}) => ({
  title, help, start, stages, field, limit: 75, goals: [], cones: [], ...options,
});

export const levels = [
  drill('四方向定點懸停', '升到 1.5 m，依序朝前、右、後、左，各懸停 10 秒。', [-1, radius, 0],
    [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(yaw => hold(-1, 1.5, 0, 10, yaw)), { limit: 120 }),
  drill('前後直線往返', '朝前飛 5 m，機頭保持朝前，倒飛回起點。', [-2.5, 1.2, 0],
    [face(2.5, 1.2, 0, 0), face(-2.5, 1.2, 0, 0)]),
  drill('左右平移往返', '不轉向，向左平移 5 m，再向右回到起點。', [0, 1.2, 2.5],
    [face(0, 1.2, -2.5, 0), face(0, 1.2, 2.5, 0)], { field: medium }),
  drill('高度控制', '依序停在 1、2.5、0.5 m 各 5 秒，再降落。', [-1, radius, 0],
    [hold(-1, 1, 0, 5), hold(-1, 2.5, 0, 5), hold(-1, .5, 0, 5), land(-1, 0)]),
  drill('方形航線', '飛完 5 × 5 m 正方形並維持機頭朝前。', [-2.5, 1.2, -2.5],
    [[2.5, -2.5], [2.5, 2.5], [-2.5, 2.5], [-2.5, -2.5]].map(([x, z]) => face(x, 1.2, z, 0)), { field: medium }),
  drill('原地偏航', '在同一點先順時針轉 360°，再反向轉 360°。', [-1, 1.3, 0],
    [spin(1, -1, 1.3, 0), spin(-1, -1, 1.3, 0)]),
  drill('X 型航線', '依序飛過五個提示球，正中央要經過一次。', [-3.1, 1.3, -2.5],
    [[-2.5, -2.5], [2.5, 2.5], [0, 0], [-2.5, 2.5], [2.5, -2.5]].map(([x, z]) => at(x, 1.3, z)), { field: medium }),
  drill('反向控制', '機頭朝向駕駛席，前進 3 m 後倒飛回起點。', [1.5, 1.3, 0, Math.PI],
    [face(-1.5, 1.3, 0, Math.PI), face(1.5, 1.3, 0, Math.PI)]),
  drill('穿越球門', '從場內正面穿過球門，再在門後懸停 5 秒。', [-.8, 1.65, 0],
    [gate(gateNarrow), hold(2.6, 2, 0, 5)], { goals: [gateNarrow] }),
  drill('基礎綜合', '起飛，穿過 5 m 外球門，轉向並返航降落。', [-3, radius, 0],
    [gate(gateNarrow), resetHeading, land(-3, 0)], { field: medium, goals: [gateNarrow], limit: 110 }),
  ...[1, -1].map(direction => drill(direction === 1 ? '順時針圓周' : '逆時針圓周',
    '沿半徑 2.5 m 的圓周飛行，機頭對準切線方向。', [2.5, 1.4, 0, direction * Math.PI / 2],
    circle(direction), { field: medium, limit: 130 })),
  ...[false, true].map(follow => drill(follow ? '機頭跟隨直立 8 字' : '定向直立 8 字',
    follow ? '連飛兩圈上下 8 字，沿路徑切換機頭朝向。' : '連飛兩圈上下 8 字，保持機頭朝前。',
    [.4, 2.72, 0], uprightEight(follow), { field: wide, limit: 190 })),
  drill('S 型繞錐', '依序繞過三個間距 3 m 的標誌錐。', [-4, 1, 0], slalom, { field: medium, cones: slalomCones }),
  drill('爬升穿門', '爬升至 2 m 穿門，向前再飛 2 m 並懸停。', [-2, .5, 0],
    [gate(gateNarrow), hold(4, 2, 0, 3)], { field: medium, goals: [gateNarrow] }),
  drill('加速與煞停', '加速向前飛 5 m，在網籠前 1 m 停住三秒再倒飛。', [-2, 1.3, 0],
    [hold(3, 1.3, 0, 3, 0), face(-2, 1.3, 0, 0)], { field: { ...medium, length: 8 } }),
  drill('雙門連續穿越', '依序穿過相距 3 m 的兩個球門。全程不要擦框。', [-2.5, 2, 0],
    [gate(goalAt(-1, 1)), gate(gateNarrow)], { goals: [goalAt(-1, 1), gateNarrow], collisionFree: true }),
  drill('Turtle Mode', '按 T 翻正。等翻正完成，再解鎖並重新起飛。', [-1, radius, 0],
    [{ type: 'turtle', p: point(-1, radius, 0), radius: .3 }, at(-1, .9, 0)], { flipped: true }),
  drill('中階綜合', '依序繞錐、穿門、飛完直立 8 字並返航降落。', [-4, radius, 0],
    [...slalom, gate(goalAt(4)), ...uprightEight(false).slice(0, 17), land(-4, 0)],
    { field: wide, goals: [goalAt(4)], cones: slalomCones, limit: 220 }),
  drill('45° 角進球', '從約 3 m 外的斜角接近，對準門心後穿越。', [-.12, 2, -2.12, Math.PI / 4],
    [at(1.12, 2, -.75), gate(gateNarrow)], { field: medium, goals: [gateNarrow] }),
  drill('進球回防', '穿門得分後返回己方半場。', [-.8, 2, 0],
    [gate(gateNarrow), home], { goals: [gateNarrow] }),
  drill('守門封鎖', '在己方門前約 50 cm 攔截紅隊球門前的來機。', [-2.4, 2, .6],
    [at(-1.5, 2, 0, { type: 'defend' })], { goals: [goalAt(-2)], opponent: 'attack' }),
  drill('高位俯衝進球', '從 2.8 m 下沉，對準 2 m 高球門穿越。', [-.7, 2.8, 0],
    [at(.8, 2.3, 0), gate(gateNarrow)], { goals: [gateNarrow] }),
  drill('Penalty Shot', '哨音後在 10 秒內穿越球門。', [-.7, 2, 0],
    [gate(gateNarrow)], { goals: [gateNarrow], limit: 10, countdown: 3, opponent: 'defend' }),
  drill('閃避防守', '避開 AI 防守機，從正面合法進球。', [-.8, 2, -.75],
    [gate(gateNarrow)], { goals: [gateNarrow], opponent: 'defend' }),
  drill('邊界控制', '沿網籠保持約 20 cm 的護籠外緣間距，通過四個角。', [-2.7, 1.4, -1.2],
    [[2.7, -1.2], [2.7, 1.2], [-2.7, 1.2], [-2.7, -1.2]].map(([x, z]) => at(x, 1.4, z, { radius: .18 }))),
  drill('循環攻防', '30 秒內完成三次進球與回半場。', [-.5, 2, 0],
    [gate(gateNarrow), home, gate(gateNarrow), home, gate(gateNarrow), home], { goals: [gateNarrow], limit: 30 }),
  drill('側向視角挑戰', '從側向視角繞過錐筒，從正面穿門。', [-2, 1.4, -.7],
    [at(0, 1.5, .7), gate(gateNarrow)], { goals: [gateNarrow], cones: [cone(0, 0)], camera: 'sideline' }),
  drill('兩分鐘綜合檢定', '確認安全清單，哨音後起飛。繞錐、斜角進球、回防，再突破防守並降落。', [-4, radius, 0],
    [{ type: 'check', p: point(-4, radius, 0) }, ...slalom, at(2, 2, -1),
      gate(gateFar), home, gate(gateFar), land(0, 0, .15)],
    { field: { length: 10, width: 6.5, height: 4 }, goals: [gateFar], cones: slalomCones, opponent: 'defend', limit: 120, countdown: 3 }),
];

export const stageLabel = stage => ({
  hold: '定點懸停', land: '對準後降落', spin: stage.direction === 1 ? '順時針偏航 360°' : '逆時針偏航 360°',
  goal: '從正面完整穿門', home: '返回紅隊半場', turtle: '完成翻正', defend: '在提示點攔截',
  check: '完成起飛前巡檢', point: stage.yaw == null ? '通過提示球' : '對準機頭並通過提示球',
})[stage.type];

export function newTraining(level, settings) {
  const [x, height, z] = level.start;
  const timedFromWhistle = level.countdown && level.stages[0].type === 'goal';
  const takeoffTarget = height > radius + .03 && !timedFromWhistle ? point(x, height, z) : null;
  return { level, stage: 0, hold: 0, spin: 0, elapsed: 0, deviation: 0, attitude: 0, started: false,
    count: 0, result: null, checked: false, recovered: false, timedFromWhistle, takeoffTarget, settings };
}

function pointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const length = dx * dx + dy * dy + dz * dz;
  const t = length ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / length, 0, 1) : 0;
  return distance(p, point(a.x + dx * t, a.y + dy * t, a.z + dz * t));
}

export function evaluateTraining(run, drone, crossed, dt, defended) {
  if (run.result) return false;
  const level = run.level;
  const stage = level.stages[run.stage];
  if (stage.type !== 'check') run.elapsed += dt;
  const near = distance(drone.p, stage.p) <= (stage.radius ?? .3);
  const aimed = stage.yaw == null || Math.abs(angleDelta(drone.yaw, stage.yaw)) < .37;
  const speed = Math.hypot(...Object.values(drone.v));
  const [x, , z] = level.start;
  const pathStart = level.stages[run.stage - 1]?.p ?? run.takeoffTarget ?? point(x, radius, z);
  run.deviation += pointToSegment(drone.p, pathStart, stage.p);
  run.attitude += Math.abs(drone.pitch) + Math.abs(drone.roll);
  run.count++;
  let passed = false;
  switch (stage.type) {
    case 'hold':
      run.hold = near && aimed && speed < .28 ? run.hold + dt : 0;
      passed = run.hold >= stage.seconds;
      break;
    case 'spin':
      run.spin = near ? Math.max(0, run.spin + drone.yawDelta * stage.direction) : 0;
      passed = run.spin >= Math.PI * 2 - .035;
      break;
    case 'goal': passed = crossed.includes(stage.gate); break;
    case 'land': passed = near && drone.p.y <= radius + .025 && speed < .18; break;
    case 'home': passed = drone.p.x < -radius - .05; break;
    case 'turtle': passed = run.recovered && !drone.recovering; break;
    case 'defend': passed = defended; break;
    case 'check': passed = run.checked; break;
    default: passed = near && aimed;
  }
  if (passed) {
    run.stage++;
    run.hold = 0;
    run.spin = 0;
  }
  const complete = run.stage === level.stages.length;
  const timedOut = run.elapsed >= level.limit * run.settings.timeScale;
  if (complete || timedOut) {
    const deviation = run.deviation / Math.max(1, run.count);
    const stability = run.attitude / Math.max(1, run.count);
    const missed = level.stages.length - run.stage;
    const timeCost = Math.max(0, run.elapsed / (level.limit * run.settings.timeScale) - .7) * 8;
    const score = Math.round(clamp(100 - drone.collisions * run.settings.collisionPenalty -
      Math.min(14, deviation * 6) - Math.min(6, stability * 3) - missed * 10 - timeCost, 0, 100));
    run.result = { pass: !missed && (!level.collisionFree || !drone.collisions) && score >= run.settings.pass,
      score, elapsed: run.elapsed, collisions: drone.collisions, deviation, stability, missed };
  }
  return passed;
}
