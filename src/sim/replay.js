import { $, button, make, download } from './browser.js';
import { TEAM_NAMES, standardGoals, field } from './config.js';
import { metrics, selectFrames } from './trace.js';

export function traceDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('drone-soccer-simulator', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('trace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveTrace(trace) {
  if (!trace.goals.length) return;
  const db = await traceDatabase();
  const transaction = db.transaction('trace', 'readwrite');
  transaction.objectStore('trace').put(trace, 'latest');
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }).finally(() => db.close());
}
export async function savedTrace() {
  const db = await traceDatabase();
  const req = db.transaction('trace').objectStore('trace').get('latest');
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

const teamColors = [0xff7185, 0x72adff];
const yellow = 0xd8f774;

function groupFrames(frames) {
  const result = new Map();
  for (const frame of frames) {
    if (!result.has(frame.id)) result.set(frame.id, []);
    result.get(frame.id).push(frame);
  }
  return result;
}

function atTime(frames, time) {
  let lower = 0, upper = frames.length - 1;
  while (lower < upper) {
    const center = Math.floor((lower + upper) / 2);
    if (frames[center].t < time) lower = center + 1;
    else upper = center;
  }
  const b = frames[lower];
  const a = frames[Math.max(0, lower - 1)];
  const fraction = b.t > a.t ? Math.min(1, Math.max(0, (time - a.t) / (b.t - a.t))) : 0;
  const interpolate = (from, to) => from.map((value, axis) => value + (to[axis] - value) * fraction);
  const [x, y, z] = interpolate(a.p, b.p);
  const [pitch, yaw, roll] = interpolate(a.rotation, b.rotation);
  return { id: a.id, team: a.team, role: a.role, p: { x, y, z }, pitch, yaw, roll,
    active: a.active, v: { x: 0, y: 0, z: 0 }, armed: true, collisions: 0 };
}

export function makeReplay(view, onStart, onClose) {
  let active;
  const toggle = $('replay-play');
  const part = $('replay-time');

  function redrawPaths() {
    if (!active) return;
    const paint = $('replay-paint').value;
    const paths = active.paths.filter(path => !active.hidden.has(path.id)).map(path => ({ ...path, paint }));
    view?.paths(paths);
  }

  function begin({ traces, paths, follow, info, selection, demo }) {
    const length = Math.max(.01, ...[...traces.values()].map(frames => frames.at(-1).t));
    active = { ...selection, traces, paths, follow, length, time: 0, playing: false,
      hidden: new Set(), demo };
    part.max = length;
    part.value = 0;
    $('replay-controls').hidden = false;
    toggle.textContent = '播放';
    $('replay-metrics').textContent = info;
    $('replay-players').replaceChildren(...[...traces].map(([id, frames]) => {
      const label = make('label', ' ' + TEAM_NAMES[frames[0].team] + ' ' + id);
      const input = make('input', '', { type: 'checkbox', checked: '' });
      input.addEventListener('change', () => {
        if (input.checked) active.hidden.delete(id);
        else active.hidden.add(id);
        redrawPaths();
      });
      label.prepend(input);
      return label;
    }));
    onStart();
    redrawPaths();
  }

  function select(trace, goal) {
    const frames = selectFrames(trace, goal, $('replay-range').value);
    if (!frames.length) return false;
    const start = frames[0].t;
    const traces = groupFrames(frames.map(frame => ({ ...frame, t: frame.t - start })));
    const paths = [...traces].map(([id, list]) => {
      const primary = id === goal.player;
      const peak = list.reduce((a, b) => Math.hypot(...b.v) > Math.hypot(...a.v) ? b : a);
      const mark = list.find(frame => frame.t >= goal.t - start);
      const high = list.reduce((a, b) => b.p[1] > a.p[1] ? b : a);
      const low = list.reduce((a, b) => b.p[1] < a.p[1] ? b : a);
      const contacts = primary ? trace.events.filter(event => event.type === 'collision' &&
        event.player === id && event.t >= start && event.t <= start + list.at(-1).t)
        .map(event => [{ p: event.p }, 0xff7f3f]) : [];
      return { id, frames: list, color: primary ? yellow : teamColors[list[0].team],
        marks: primary ? [[list[0], 0xffffff], [peak, 0x26deff], [high, 0xc5a7ff], [low, 0xa08dce], [mark, yellow], ...contacts] : [] };
    });
    const stats = metrics(trace, goal);
    const value = (n, suffix) => n == null ? '—' : Number(n).toFixed(2) + suffix;
    const info = [TEAM_NAMES[goal.team] + ' · Set ' + goal.set, '長度 ' + value(stats.length, ' m'),
      '耗時 ' + value(stats.duration, ' s'), '均速 ' + value(stats.meanSpeed, ' m/s'),
      '最快 ' + value(stats.peak, ' m/s'), '平均高度 ' + value(stats.meanHeight, ' m'),
      '碰撞 ' + stats.collisions, '進球角度 ' + value(goal.angle, '°'), '進球速度 ' + value(goal.speed, ' m/s'),
      '最近防守者 ' + value(goal.defenderDistance, ' m'), '回半場 ' + value(goal.returned, ' s')].join('　');
    begin({ traces, paths, follow: goal.player, info, selection: { field: trace.field, goals: trace.goalsGeometry } });
    return true;
  }

  function compare(trace) {
    const paths = trace.goals.map((goal, index) => ({
      id: goal.goalId, color: teamColors[goal.team], frames: selectFrames(trace, goal, 'attack').filter(frame => frame.id === goal.player),
      marks: [[{ p: [goal.x, goal.height, goal.z] }, index % 2 ? 0xfdf0da : yellow]],
    })).filter(path => path.frames.length > 1);
    if (!paths.length) return false;
    begin({ traces: new Map(), paths, info: '共 ' + paths.length + ' 條進球路線。紅色為紅隊，藍色為藍隊。',
      selection: { field: trace.field, goals: trace.goalsGeometry } });
    $('replay-players').replaceChildren(...paths.map((path, index) => {
      const label = make('label', ' 第 ' + (index + 1) + ' 球');
      const input = make('input', '', { type: 'checkbox', checked: '' });
      input.onchange = () => {
        if (input.checked) active.hidden.delete(path.id);
        else active.hidden.add(path.id);
        redrawPaths();
      };
      label.prepend(input);
      return label;
    }));
    return true;
  }

  function demonstrate(training, actual = []) {
    const path = training.level.stages.filter(stage => stage.p).map((stage, index) => ({
      id: '示範', p: Object.values(stage.p), t: index, team: 0, role: 'striker', active: true, v: [0, 0, 0], rotation: [0, 0, 0],
    }));
    const paths = [{ id: '示範', frames: path, color: yellow }];
    if (actual.length > 1) paths.push({ id: '實飛', frames: actual, color: 0x55a7ff });
    begin({ traces: new Map([['示範', path], ...(actual.length > 1 ? [['實飛', actual]] : [])]), paths,
      follow: '示範', info: '黃線是關卡建議路徑，藍線是本次實際飛行路徑。',
      selection: { field: training.level.field, goals: training.level.goals, training }, demo: true });
  }

  function stop() {
    active = undefined;
    view?.paths([]);
    $('replay-controls').hidden = true;
    onClose();
  }

  toggle.onclick = () => {
    if (!active) return;
    if (!active.playing && active.time >= active.length) active.time = 0;
    active.playing = !active.playing;
    toggle.textContent = active.playing ? '暫停' : '播放';
  };
  part.oninput = () => { if (active) active.time = Number(part.value); };
  $('replay-frame').onclick = () => { if (active) { active.playing = false; active.time = Math.min(active.length, active.time + 1 / 30); toggle.textContent = '播放'; } };
  $('replay-restart').onclick = () => { if (active) { active.time = 0; active.playing = true; toggle.textContent = '暫停'; } };
  $('replay-paint').onchange = redrawPaths;
  $('replay-close').onclick = stop;
  $('replay-png').onclick = () => { if (view) download('drone-soccer.png', view.image()); };

  return { select, compare, demonstrate, stop, get active() { return Boolean(active); },
    tick(dt) {
      if (!active) return;
      if (active.playing) {
        active.time = Math.min(active.length, active.time + dt * Number($('replay-speed').value));
        if (active.time >= active.length) { active.playing = false; toggle.textContent = '播放'; }
      }
      part.value = active.time;
      $('replay-clock').value = active.time.toFixed(2) + ' s';
      const drones = [...active.traces].filter(([id]) => !active.hidden.has(id))
        .map(([, frames]) => atTime(frames, active.time));
      view?.draw({ drones, field: active.field ?? field, goals: active.goals ?? standardGoals(6),
        time: active.time }, active.follow, dt, { playingReplay: true, training: active.training, hints: false });
    },
  };
}
