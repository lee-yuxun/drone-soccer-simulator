import { $, button, make, store, read, download, csv, makeAudio, makeInput, humanKey, labelKeys } from './browser.js';
import { controlDefaults, courseDefaults, field, profiles, ROLE_NAMES, secondPilotId, STEP, TEAM_NAMES } from './config.js';
import { gameCreate, doAction, tickGame } from './game.js';
import { neutral } from './flight.js';
import { padBindings, padInstruction, padValues, touchAxis } from './gamepad.js';
import { levels, stageLabel } from './training.js';
import { metrics } from './trace.js';
import { createView } from './view.js';
import { makeLan } from './lan.js';
import { makeReplay, saveTrace, savedTrace } from './replay.js';
import { mountRulesLesson } from './rules-lesson.js';

const controls = { ...structuredClone(controlDefaults), ...read('controls', {}) };
const course = { ...courseDefaults, ...read('teacher', {}) };
const options = { profileId: 'course-3v3', pilotRole: 'striker', matchKind: 'solo', setSeconds: 180, breakSeconds: 120, height: 3, difficulty: 'normal',
  ...read('match-options', {}) };
const cameras = ['sideline', 'follow', 'fpv', 'goal', 'top', 'orbit'];
const initialCamera = 'follow';
const matchNames = { solo: '單人練習賽', versus: '同機雙人對抗', coop: '同機雙人合作' };
const touchNames = { yaw: '偏航', throttle: '油門', roll: '滾轉', pitch: '俯仰' };
const ui = {};
for (const id of ['red-score', 'blue-score', 'time-label', 'clock', 'role-tag', 'banner', 'altitude', 'speed',
  'collisions', 'event-toast', 'arm', 'reset', 'turtle', 'pause', 'stop', 'mode-title', 'mode-copy', 'flight-status',
  'input-status', 'field-status', 'mode-extra', 'left-stick', 'right-stick', 'pitch', 'roll', 'heading']) ui[id] = $(id);
let view;
try {
  view = createView($('stage'));
  view.quality(controls.quality);
  view.shake(controls.shake);
} catch (error) {
  $('webgl-fallback').hidden = false;
  console.error('WebGL setup:', error);
}
const audio = makeAudio(controls);
let selectedLevel = Number(read('level', 1)) || 1;
selectedLevel = Math.min(levels.length, Math.max(1, selectedLevel));
let mode = 'free';
let local;
let remote;
let remoteId;
let toastUntil = 0;
let seen = 0;
let eventScope = '';
let persisted = 0;
let records = read('scores', []);
let previousTrace;
let remoteSummary;
let remoteFull;
const remoteClips = new Map();
const traceRequests = new Map();
let requestCount = 0;
let resultSaved = false;
let lastTrialSample = -1;
let trainingPath = [];
let camera = initialCamera;
let cameraBeforeReplay;
let accumulator = 0;
let last = performance.now();
let lastHud = 0;
let lastDraw = 0;
let controllerSignature;
let calibrationState;
let localPausedBeforeReplay = false;
let timing = {};
const input = makeInput(controls, action, saveControls);
const touchLayout = matchMedia('(any-pointer: coarse), (max-width: 690px)');
let virtualOverride;
function updateVirtualControls() {
  const shown = virtualOverride ?? touchLayout.matches;
  $('small-sticks').hidden = !shown;
  $('virtual-controls').setAttribute('aria-pressed', String(shown));
  if (!shown) input.clearVirtual();
}
touchLayout.addEventListener('change', updateVirtualControls);
$('virtual-controls').onclick = () => {
  virtualOverride = $('small-sticks').hidden;
  updateVirtualControls();
};
updateVirtualControls();
const replay = makeReplay(view, () => {
  if (cameraBeforeReplay === undefined) {
    cameraBeforeReplay = camera;
    localPausedBeforeReplay = local.paused;
  }
  if (mode !== 'lan') local.paused = true;
  for (const popup of document.querySelectorAll('dialog[open]')) popup.close();
  changeCamera('sideline');
  $('replay-controls').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}, () => {
  if (local && mode !== 'lan') local.paused = localPausedBeforeReplay;
  changeCamera(cameraBeforeReplay ?? initialCamera);
  cameraBeforeReplay = undefined;
});

const lan = makeLan(state => {
  if (!state) {
    remote = undefined;
    remoteId = undefined;
    openMode('free');
    return;
  }
  const first = remoteId !== state.id;
  remote = state;
  remoteId = state.id;
  if (first) {
    input.shared(false);
    if (replay.active) replay.stop();
    mode = 'lan';
    remoteSummary = undefined;
    remoteFull = undefined;
    remoteClips.clear();
    traceRequests.clear();
    local.paused = true;
    seen = 0;
    syncTabs();
    changeCamera(initialCamera);
    renderMode();
    $('lan-dialog').close();
  }
}, message => {
  if (message.type === 'summary') {
    remoteSummary = message.trace;
    if ($('replay-dialog').open) renderGoals();
  }
  if (message.type !== 'trace') return;
  if (message.trace.matchId !== remoteId) return;
  if (message.full) remoteFull = message.trace;
  else if (message.trace.goals[0]) remoteClips.set(message.trace.goals[0].goalId, message.trace);
  if (message.trace.samples.length && (message.full || remote?.phase !== 'finished')) {
    previousTrace = message.full ? message.trace : mergeRoomClips();
    saveTrace(previousTrace).catch(() => {});
  }
  const job = traceRequests.get(message.requestId);
  traceRequests.delete(message.requestId);
  if (job) job(message.trace);
}, () => options, controls);

function changeCamera(name) {
  camera = name;
  $('camera').value = name;
  view?.mode(name);
}
$('camera').onchange = () => changeCamera($('camera').value);

function syncTabs() {
  for (const node of document.querySelectorAll('[data-mode]')) {
    node.setAttribute('aria-pressed', String(node.dataset.mode === mode));
  }
  document.querySelector('[data-mode-entry=lan]').setAttribute('aria-pressed', String(mode === 'lan'));
}
function openMode(value) {
  if (replay.active) replay.stop();
  if (local?.trace?.goals.length) {
    previousTrace = local.trace;
    saveTrace(previousTrace).catch(() => {});
  }
  mode = value;
  if (mode === 'lan' && remote) { renderMode(); syncTabs(); return; }
  const settings = {
    height: options.height, setSeconds: options.setSeconds, breakSeconds: options.breakSeconds,
  };
  local = gameCreate({ mode, level: selectedLevel, profileId: mode === 'match' ? options.profileId : 'course-3v3',
    pilotRole: options.pilotRole, matchKind: options.matchKind, controls, course, settings, difficulty: options.difficulty,
  });
  timing = {};
  accumulator = 0;
  resultSaved = false;
  persisted = 0;
  seen = 0;
  eventScope = '';
  trainingPath = [];
  lastTrialSample = -1;
  input.shared(isShared());
  syncTabs();
  changeCamera(isShared() ? 'sideline' : local.practice?.camera ?? initialCamera);
  renderMode();
  updateHud(performance.now());
}

function isShared() { return mode === 'match' && local?.matchKind !== 'solo'; }

function action(name, player = 1) {
  audio.enable();
  if (name === 'camera') {
    changeCamera(cameras[(cameras.indexOf(camera) + 1) % cameras.length]);
    return;
  }
  if (name === 'pause') {
    if (mode === 'lan') { openDialog('lan-dialog'); return; }
    openDialog('pause-dialog');
    return;
  }
  if (name === 'reset') {
    if (mode !== 'lan') openMode(mode);
    return;
  }
  if (replay.active) return;
  if (mode === 'lan') lan.act(name);
  else doAction(local, player === 2 ? secondPilotId : local.pilotId, name);
}

function setText(node, value) {
  const text = String(value);
  if (node.textContent !== text) node.textContent = text;
}
function showToast(message, now = performance.now(), keep = 2600) {
  setText(ui['event-toast'], message);
  ui['event-toast'].hidden = false;
  toastUntil = now + keep;
}
const clock = n => {
  const sec = Math.max(0, Math.floor(n + .0001));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
};
const deg = radians => Math.round(radians * 180 / Math.PI) + '°';
const phaseName = phase => ({ countdown: '倒數起飛', break: '局間休息', penalty: 'Penalty Shot',
  golden: '黃金進球', finished: '完賽', inspection: '起飛前巡檢' })[phase];
function stateNow() { return mode === 'lan' ? remote ?? local : local; }
function ownNow() { return mode === 'lan' ? lan.id : local.pilotId; }

function events(state, own, now) {
  if (eventScope !== state.id) { eventScope = state.id; seen = 0; }
  for (const event of state.events) {
    const sequence = Number(event.id.split(':').at(-1));
    if (sequence <= seen) continue;
    seen = sequence;
    switch (event.type) {
      case 'goal': {
        audio.sound('goal', event.id);
        showToast(TEAM_NAMES[event.team] + '進球！' +
          (event.score && mode !== 'training' ? '　' + event.score.join(' : ') : ''), now);
        if (mode === 'lan') {
          lan.requestTrace(event.id);
          const matchId = state.id;
          setTimeout(() => { if (remote?.id === matchId) lan.requestTrace(event.id); }, 2300);
        }
        break;
      }
      case 'foul': showToast(TEAM_NAMES[event.team] + '｜' + event.reason, now, 3500); break;
      case 'return': showToast(TEAM_NAMES[event.team] + '已回半場，可以再次進攻', now); break;
      case 'collision':
        if (event.player === own) { view?.bump(); showToast('碰撞 · 放慢速度並離開障礙', now, 1400); }
        break;
      case 'turtle':
        if (event.player === own) showToast('已啟動翻正，完成後再解鎖', now);
        break;
      case 'start': audio.sound('start', event.id); showToast('哨音已響，可以起飛', now); break;
      case 'penalty': audio.sound('penalty', event.id); showToast(TEAM_NAMES[event.team] + '獲得 10 秒罰球', now); break;
      case 'setEnd': audio.sound('setEnd', event.id); showToast('本局由' + TEAM_NAMES[event.team] + '獲勝', now); break;
      case 'finished': audio.sound('finished', event.id); showToast(TEAM_NAMES[event.team] + '贏得比賽', now, 8000); if (mode === 'lan') lan.requestTrace(); break;
      default: break;
    }
  }
}

function titleForState(state) {
  if (state.paused && !replay.active) return '已暫停';
  if (state.phase === 'inspection') return '先完成起飛前巡檢';
  if (state.phase === 'countdown') return '準備起飛　' + Math.ceil(state.remaining);
  if (state.phase === 'break') return '局間休息　' + clock(Math.ceil(state.remaining)) + '　' + state.score.join(' : ');
  if (state.phase === 'finished') {
    const winner = state.wins[0] > state.wins[1] ? 0 : 1;
    return TEAM_NAMES[winner] + '獲勝　' + state.wins.join(' : ');
  }
  if (state.phase === 'penalty') return TEAM_NAMES[state.penalty.team] + '罰球　' + Math.ceil(state.penalty.lasts);
  if (state.phase === 'golden') return '黃金進球';
  if (local.training?.result && mode === 'training') return local.training.result.pass ? 'PASS · 通過' : 'RETRY · 再練一次';
  return '';
}

function updateHud(now) {
  const state = stateNow();
  const own = ownNow();
  const player = state.drones.find(drone => drone.id === own);
  const training = mode === 'training' ? local.training : null;
  setText(ui['red-score'], String(state.score[0]).padStart(2, '0'));
  setText(ui['blue-score'], String(state.score[1]).padStart(2, '0'));
  const competitive = mode === 'match' || mode === 'lan';
  const remaining = mode === 'lan' ? state.remaining : state.penalty?.lasts ?? state.remaining;
  const timerLabel = phaseName(state.phase) ?? (competitive ? 'SET ' + state.setNumber + ' · 局勝 ' +
    state.wins.join('–') : training ? '訓練剩餘' : '飛行時間');
  const timerValue = competitive || state.phase === 'countdown' ? Math.ceil(Math.max(0, remaining ?? 0)) :
    training ? Math.ceil(Math.max(0, training.level.limit * training.settings.timeScale - training.elapsed)) : state.time;
  setText(ui['time-label'], timerLabel);
  setText(ui.clock, clock(timerValue));
  setText(ui['role-tag'], player ? (player.team ? '◆ ' : '▲ ') + TEAM_NAMES[player.team] + ' · ' +
    ROLE_NAMES[player.role] : '觀戰席');
  ui['role-tag'].style.color = player?.team === 1 ? 'var(--blue)' : '';
  setText(ui.altitude, (player?.p.y ?? 0).toFixed(2));
  setText(ui.speed, Math.hypot(...Object.values(player?.v ?? { x: 0, y: 0, z: 0 })).toFixed(2));
  setText(ui.collisions, player?.collisions ?? 0);
  const values = player?.input ?? neutral();
  for (const side of ['left', 'right']) {
    const axes = touchAxis(side, controls.stickMode);
    ui[side + '-stick'].style.setProperty('--stick-x', values[axes.x]);
    ui[side + '-stick'].style.setProperty('--stick-y', -values[axes.y]);
  }
  const partner = isShared() ? state.drones.find(drone => drone.id === secondPilotId) : null;
  $('shared-hud').hidden = !partner;
  if (partner) {
    setText($('shared-status'), '玩家 2 · ' + TEAM_NAMES[partner.team] + ' ' + ROLE_NAMES[partner.role] +
      ' · 高度 ' + partner.p.y.toFixed(2) + ' m');
    setText($('arm-p2'), partner.armed ? '玩家 2 上鎖（M）' : '玩家 2 解鎖（M）');
    $('arm-p2').disabled = !partner.active || partner.flipped || partner.recovering || state.phase === 'finished';
    $('stop-p2').disabled = !partner.active || !partner.armed;
  }
  setText(ui.pitch, deg(player?.pitch ?? 0));
  setText(ui.roll, deg(player?.roll ?? 0));
  setText(ui.heading, Math.round((((player?.yaw ?? 0) * 180 / Math.PI) % 360 + 360) % 360) % 360 + '°');
  const nearWall = player && (Math.abs(player.p.x) > state.field.length / 2 - .27 ||
    Math.abs(player.p.z) > state.field.width / 2 - .27 || player.p.y > state.field.height - .27);
  const flightStatus = player ? (!player.active ? '暫停上場 · 罰球中' : player.flipped ? '翻覆 · 落地後按 T' : player.recovering ? '翻正中' :
    player.armed ? state.blocked[player.team] ? '回己方半場' : nearWall ? '接近網籠' : '已解鎖' : '待解鎖') : '觀戰';
  setText(ui['flight-status'], flightStatus);
  ui.arm.firstChild.nodeValue = player?.armed ? '鎖定馬達 ' : '解鎖馬達 ';
  ui.arm.disabled = !player?.active || player.flipped || ['inspection', 'break', 'finished'].includes(state.phase) || replay.active;
  ui.turtle.disabled = !player?.active || !player.flipped || replay.active;
  ui.stop.disabled = !player?.active || !player.armed || replay.active;
  ui.reset.disabled = mode === 'lan' || replay.active;
  const padSource = input.pad ? input.profile ? 'ELRS／手把' : '手把待校正' : $('small-sticks').hidden ? '鍵盤' : '鍵盤／觸控';
  setText(ui['input-status'], padSource + (mode === 'lan' ? ' · ' +
    (lan.online ? lan.latency + ' ms' : '離線') : ''));
  $('controller-button').toggleAttribute('data-connected', Boolean(input.profile));
  if ($('controller-dialog').open) updateControllerPanel();
  setText(ui['field-status'], [state.field.length, state.field.width, state.field.height].join(' × ') + ' m');
  const banner = titleForState(state);
  ui.banner.hidden = !banner || replay.active;
  setText(ui.banner, banner);
  if (now > toastUntil) ui['event-toast'].hidden = true;
  if (timing.progress && training) {
    const stage = training.level.stages[training.stage];
    timing.progress.value = training.stage;
    const step = stage ? (training.stage + 1) + '/' + training.level.stages.length + ' · ' +
      stageLabel(stage) + (stage.seconds ? '　' + training.hold.toFixed(1) + '/' + stage.seconds + ' 秒' : '') : '路線已完成';
    const instruction = !training.started && training.takeoffTarget ?
      '解鎖後垂直起飛，先到 ' + training.takeoffTarget.y + ' m 的提示球' : step;
    setText(timing.segment, instruction);
    if (training.result && !resultSaved) saveResult(training);
  }
  const setsText = state.sets?.length ? state.sets.map((score, index) =>
    'Set ' + (index + 1) + ' ' + score.join(' : ')).join('　') : '';
  if (timing.sets) setText(timing.sets, setsText);
  if (timing.penalties) setText(timing.penalties, '犯規 ' + (state.penalties ?? [0, 0]).join(' : '));
  if (timing.analysis) timing.analysis.hidden = !state.trace?.goals.length && !state.traceGoals?.length;
}

function optionMenu(label, values, selected, run, id) {
  const slot = make('label', label);
  const select = make('select', '', id ? { id } : {});
  for (const [value, text] of values) select.append(make('option', text, { value: String(value) }));
  select.value = String(selected);
  select.onchange = () => run(select.value);
  slot.append(select);
  return slot;
}

function saveOptions() { store('match-options', options); }
function matchOptions(target, includeSize = false) {
  const items = [];
  if (includeSize) items.push(optionMenu('隊伍大小', [[3, '3v3'], [5, '5v5']], 3,
    value => lan.size(Number(value)), 'room-size'));
  items.push(
    optionMenu('規則設定', Object.entries(profiles).map(([id, profile]) => [id, profile.name]),
      options.profileId, value => { options.profileId = value; saveOptions(); }),
    optionMenu('AI 難度', [['easy','簡單'], ['normal','中等'], ['hard','困難']],
      options.difficulty, value => { options.difficulty = value; saveOptions(); }),
    optionMenu('每局時間', [...(includeSize ? [] : [[60,'1 分鐘快打']]), [120,'2 分鐘'], [180,'3 分鐘'], [240,'4 分鐘'], [300,'5 分鐘']],
      includeSize && options.setSeconds === 60 ? 180 : options.setSeconds, value => { options.setSeconds = Number(value); saveOptions(); }),
    optionMenu('局間休息', [[120,'2 分鐘'], [150,'2 分半'], [180,'3 分鐘'], [240,'4 分鐘'], [300,'5 分鐘']],
      options.breakSeconds, value => { options.breakSeconds = Number(value); saveOptions(); }),
    optionMenu('場地高度', [[3,'3 m'], [4,'4 m · 課程擴充']], options.height,
      value => { options.height = Number(value); saveOptions(); }),
  );
  target.replaceChildren(...items);
}

function renderMode() {
  timing = {};
  const extra = ui['mode-extra'];
  const strip = $('training-strip');
  extra.replaceChildren();
  strip.replaceChildren();
  strip.hidden = mode !== 'training';
  if (mode === 'training') {
    const training = local.training;
    setText(ui['mode-title'], training.level.title);
    setText(ui['mode-copy'], training.level.help);
    const selector = optionMenu('選擇訓練關卡', levels.map((level, i) =>
      [i + 1, (i < 10 ? '雛鳥' : i < 20 ? '麻雀' : '隼鷹') + ' ' + (i + 1) + '｜' + level.title]),
      selectedLevel, chosen => { selectedLevel = Number(chosen); store('level', selectedLevel); openMode('training'); }, 'level');
    timing.segment = make('span');
    timing.progress = make('progress', '', { max: training.level.stages.length, value: 0, 'aria-label': '訓練進度' });
    const progress = make('div', '', { class: 'training-progress' });
    progress.append(timing.segment, timing.progress);
    strip.append(selector, progress);
    if (training.level.stages[0]?.type === 'check') strip.append(button('起飛前巡檢', () => openDialog('safety-dialog')));
  } else if (mode === 'match' || mode === 'lan') {
    const state = stateNow();
    setText(ui['mode-title'], mode === 'lan' ? '區網比賽' : matchNames[local.matchKind]);
    setText(ui['mode-copy'], (profiles[state.profileId]?.name ?? '') + ' · 先贏兩局。' +
      (mode === 'match' ? isShared() ? ' 玩家 2 使用 I／K 升降、J／L 偏航、U／O 前後、Y／P 左右，M 解鎖。' : ' AI 訓練輔助。' : ' 由房主伺服器同步。'));
    timing.sets = make('p');
    timing.penalties = make('p');
    timing.analysis = button('檢視進球軌跡', () => openDialog('replay-dialog'));
    extra.append(timing.sets, timing.penalties, timing.analysis);
    if (mode === 'match') {
      const details = make('details');
      details.append(make('summary', '比賽設定'));
      const box = make('div');
      matchOptions(box);
      details.append(box, button('選擇角色並開始新賽', () => openDialog('match-start-dialog')));
      extra.append(details);
    } else extra.append(button('開啟房間', () => openDialog('lan-dialog')));
  } else {
    setText(ui['mode-title'], '自由飛行');
    setText(ui['mode-copy'], '在紅藍球場練習起飛、懸停與穿門。');
    extra.append(optionMenu('場地高度', [[3,'3 m · 標準場地'], [4,'4 m · 課程擴充']], options.height,
      value => { options.height = Number(value); saveOptions(); $('flight-dialog').close(); openMode('free'); }));
  }
}

function saveResult(training) {
  resultSaved = true;
  const result = training.result;
  const tag = ($('student').value || 'PILOT').trim().replace(/^[=+@-]/, '') || 'PILOT';
  const row = { student: tag, date: new Date().toISOString(), level: selectedLevel, ...result };
  records = [row, ...records].slice(0, 350);
  store('scores', records);
  const pane = make('div', '', { class: 'result' + (result.pass ? '' : ' fail') });
  pane.append(make('strong', (result.pass ? 'PASS' : 'RETRY') + ' · ' + result.score + ' 分'),
    make('p', result.elapsed.toFixed(1) + ' 秒 · 碰撞 ' + result.collisions + ' 次 · 平均偏差 ' +
      result.deviation.toFixed(2) + ' m · 漏點 ' + result.missed),
    make('p', result.pass ? '可以挑戰下一關。' : result.missed ? '依亮起的提示球逐點完成。' :
      result.collisions ? '接近球門與邊界時先減速。' : '降低傾角、穩住高度，再沿提示路線飛行。'));
  pane.append(button('再練一次', () => openMode('training')));
  if (selectedLevel < levels.length) pane.append(button('下一關', () => {
    selectedLevel++; store('level', selectedLevel); openMode('training');
  }));
  $('training-strip').append(pane);
}

function labelTouchControls() {
  for (const side of ['left', 'right']) {
    const axes = touchAxis(side, controls.stickMode);
    const label = touchNames[axes.y] + ' · ' + touchNames[axes.x];
    setText($(side + '-controls-label'), label);
    $(side + '-pocket').setAttribute('aria-label', label);
  }
  setText($('virtual-controls'), '雙搖桿 · Mode ' + controls.stickMode);
  setText($('pad-calibrate'), '開始 Mode ' + controls.stickMode + ' 校正');
}

function saveControls() {
  store('controls', controls);
  if (local) Object.assign(local.controls, controls);
  view?.shake(controls.shake);
  lan.updateControls();
}

function table(host, header, rows, owned = false) {
  if (owned) {
    const tableNode = make('table');
    const head = make('thead');
    const row = make('tr');
    for (const name of header) row.append(make('th', name));
    head.append(row);
    const body = make('tbody');
    tableNode.append(head, body);
    host.replaceChildren(tableNode);
    host = body;
  }
  host.replaceChildren(...rows.map(items => {
    const row = make('tr');
    for (const content of items) row.append(make('td', String(content)));
    return row;
  }));
}

function openDialog(id) {
  input.clear();
  const popup = $(id);
  if (id === 'pause-dialog' && mode !== 'lan') local.paused = true;
  if (id === 'match-start-dialog' && !popup.open) {
    const form = $('match-start-form');
    form.elements.namedItem('pilot-role').value = options.pilotRole === 'defender' ? 'defender' : 'striker';
    form.elements.namedItem('match-kind').value = Object.hasOwn(matchNames, options.matchKind) ? options.matchKind : 'solo';
    const round = form.elements.namedItem('round-seconds');
    round.disabled = options.profileId === 'fai-f9ab-2026';
    round.value = round.disabled ? '180' : String(options.setSeconds);
    updateMatchHelp();
  }
  if (id === 'settings-dialog') input.keyButtons($('key-settings'));
  if (id === 'controller-dialog' && !popup.open) {
    controllerSignature = undefined;
    calibrationState = undefined;
    setText($('pad-detect'), '');
    updateControllerPanel();
  }
  if (id === 'controls-dialog') table($('quick-keys'), [], [
    ...labelKeys.map((label, i) => [label, humanKey(controls.keys[i])]),
    ['解鎖／鎖定馬達', 'Space'], ['翻正', 'T'], ['重設', 'Z'], ['切換視角', 'C'], ['停槳', 'X'],
  ]);
  if (id === 'records-dialog') renderRecords();
  if (id === 'replay-dialog') { if (mode === 'lan') lan.requestSummary(); renderGoals(); }
  if (!popup.open) popup.showModal();
}

document.addEventListener('click', event => {
  const node = event.target.closest('button');
  if (!node) return;
  audio.enable();
  const { mode: value, dialog } = node.dataset;
  if (value === 'match') openDialog('match-start-dialog');
  else if (value) openMode(value);
  if (dialog) openDialog(dialog);
  if (node.hasAttribute('data-close')) node.closest('dialog')?.close();
});
function updateMatchHelp() {
  $('shared-help').hidden = $('match-start-form').elements.namedItem('match-kind').value === 'solo';
}
$('match-start-form').onchange = updateMatchHelp;
$('match-start-form').onsubmit = event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  options.pilotRole = data.get('pilot-role');
  options.matchKind = data.get('match-kind');
  options.setSeconds = Number(data.get('round-seconds') ?? 180);
  saveOptions();
  $('match-start-dialog').close();
  $('flight-dialog').close();
  openMode('match');
};
$('pause-dialog').addEventListener('close', () => { if (!replay.active) local.paused = false; });
$('settings-dialog').addEventListener('close', () => input.cancel());
$('controller-dialog').addEventListener('close', () => input.cancel());
for (const id of ['arm', 'reset', 'turtle', 'stop', 'pause']) $(id).onclick = () => { action(id); $(id).blur(); };
$('restart-run').onclick = () => { $('pause-dialog').close(); openMode(mode); };
$('return-free').onclick = () => { $('pause-dialog').close(); openMode('free'); };
$('arm-p2').onclick = () => action('arm', 2);
$('stop-p2').onclick = () => action('stop', 2);
$('test-sound').onclick = () => { audio.enable(); audio.sound('goal'); };
$('student').value = read('student', 'PILOT');
$('student').onchange = () => store('student', $('student').value);

const boxes = [...$('checklist').querySelectorAll('input')];
for (const box of boxes) box.onchange = () => { $('confirm-check').disabled = boxes.some(box => !box.checked); };
$('confirm-check').onclick = () => {
  $('safety-dialog').close();
  if (mode === 'training') doAction(local, local.pilotId, 'check');
  showToast('巡檢完成。');
};
function renderRecords() {
  if (!records.length) $('record-table').replaceChildren(make('p', '目前沒有訓練成績。'));
  else table($('record-table'), ['學員', '日期', '關卡', '時間', '碰撞', '得分', '結果'], records.map(row =>
    [row.student, new Date(row.date).toLocaleDateString('zh-TW'), row.level, row.elapsed.toFixed(1) + ' s',
      row.collisions, row.score, row.pass ? 'PASS' : 'RETRY']), true);
  $('export-records').disabled = !records.length;
  $('training-demo').disabled = mode !== 'training' || !local.training;
}
$('export-records').onclick = () => download('training-scores.csv', csv([
  ['學員代號', '日期', '關卡', '秒', '碰撞', '偏差公尺', '得分', '結果'],
  ...records.map(row => [row.student, row.date, row.level, row.elapsed.toFixed(2), row.collisions,
    row.deviation.toFixed(3), row.score, row.pass ? 'PASS' : 'RETRY']),
]), 'text/csv;charset=utf-8');
$('training-demo').onclick = () => { if (local.training) replay.demonstrate(local.training, trainingPath); };

const traceNow = () => mode === 'lan' ? remoteFull : local.trace?.goals.length ? local.trace : previousTrace;
function mergeRoomClips() {
  const clips = [...remoteClips.values()];
  return {
    ...clips.at(-1),
    goals: clips.flatMap(clip => clip.goals).sort((a, b) => a.t - b.t),
    samples: [...new Map(clips.flatMap(clip => clip.samples)
      .map(frame => [frame.id + ':' + frame.t, frame])).values()].sort((a, b) => a.t - b.t),
    events: [...new Map(clips.flatMap(clip => clip.events)
      .map(event => [event.id, event])).values()].sort((a, b) => a.t - b.t),
  };
}
function withTrace(callback, goalId, needsAll = false) {
  if (mode === 'lan') {
    const cached = needsAll ? remoteFull : remoteClips.get(goalId) ?? remoteFull;
    if (cached && (remote?.phase === 'finished' || goalId && remote?.time > (cached.goals.find(goal => goal.goalId === goalId)?.t ?? 0) + 2.1)) {
      callback(cached);
    } else if (lan.online) {
      const requestId = ++requestCount;
      traceRequests.set(requestId, callback);
      setTimeout(() => traceRequests.delete(requestId), 12000);
      lan.requestTrace(needsAll ? undefined : goalId, requestId);
    }
  } else {
    const trace = traceNow();
    if (trace) callback(trace);
  }
}
function renderGoals() {
  const goals = mode === 'lan' ? remote?.traceGoals ?? remoteSummary?.goals ?? [] : traceNow()?.goals ?? [];
  for (const name of ['compare-goals', 'export-json', 'export-goals']) $(name).disabled = !goals.length;
  const list = $('goal-list');
  if (!goals.length) {
    list.replaceChildren(make('p', '完成一場練習賽的首次進球後，軌跡會顯示在這裡。'));
    return;
  }
  list.replaceChildren(...goals.map((goal, i) => button('第 ' + (i + 1) + ' 球 · Set ' + goal.set +
    ' · ' + TEAM_NAMES[goal.team] + ' · ' + goal.player + ' · ' + clock(goal.clock) + ' · ' + goal.score.join(' : '),
  () => withTrace(result => {
    const selected = result.goals.find(item => item.goalId === goal.goalId);
    if (selected && !replay.select(result, selected)) list.prepend(make('p', '這球的軌跡取樣尚未完成，請稍後再試。'));
  }, goal.goalId))));
}
$('compare-goals').onclick = () => withTrace(trace => replay.compare(trace), undefined, true);
$('export-json').onclick = () => withTrace(trace => download('match-trace.json', JSON.stringify(trace), 'application/json'), undefined, true);
$('export-goals').onclick = () => withTrace(trace => download('goals.csv', csv([
  ['局', '得分隊', '選手代號', '局剩餘秒數', '比分', '進球速度', '角度', '路徑長度', '攻擊秒數'],
  ...trace.goals.map(goal => {
    const data = metrics(trace, goal);
    return [goal.set, TEAM_NAMES[goal.team], goal.player, goal.clock, goal.score.join(':'), goal.speed,
      goal.angle, data.length, data.duration];
  }),
]), 'text/csv;charset=utf-8'), undefined, true);

function range(object, key, name, min, max, step, change) {
  const label = make('label');
  const caption = make('span', name);
  const value = make('output', String(object[key]));
  caption.append(value);
  const input = make('input', '', { type: 'range', min, max, step, value: object[key] });
  input.oninput = () => { object[key] = Number(input.value); value.textContent = input.value; change(); };
  label.append(caption, input);
  return label;
}
function check(object, key, name, change) {
  const wrap = make('label', name);
  const control = make('input', '', { type: 'checkbox' });
  control.checked = object[key];
  control.onchange = () => { object[key] = control.checked; change(); };
  wrap.prepend(control);
  return wrap;
}
const settingsTabs = [...document.querySelectorAll('[data-settings]')];
for (const tab of settingsTabs) tab.onclick = () => {
  for (const item of settingsTabs) {
    const active = item === tab;
    item.setAttribute('aria-pressed', String(active));
    $(item.getAttribute('aria-controls')).hidden = !active;
  }
};

function settingChoices(title, id, choices, selected, change) {
  const row = make('fieldset', '', { class: 'setting-choice' });
  row.append(make('legend', title));
  const items = choices.map(([value, name, hint]) => {
    const node = button(name, () => {
      change(value);
      for (const item of items) item.setAttribute('aria-pressed', String(item === node));
    }, { ['data-' + id]: String(value), 'aria-pressed': String(value === selected) });
    if (hint) node.append(make('small', hint));
    return node;
  });
  row.append(...items);
  return row;
}

labelTouchControls();
const advancedFlight = make('details');
const flightAdjustments = make('div', '', { class: 'form-grid' });
flightAdjustments.append(
  range(controls, 'sensitivity', '搖桿靈敏度', .4, 1.8, .05, saveControls),
  range(controls, 'tilt', '最大傾角 °', 15, 45, 1, saveControls),
  range(controls, 'thrust', '推力', .7, 1.4, .05, saveControls),
  range(controls, 'damping', '阻尼', .5, 1.7, .05, saveControls),
  range(controls, 'bounce', '碰撞反彈', .15, .65, .05, saveControls),
);
advancedFlight.append(make('summary', '進階飛行調校'), flightAdjustments);
$('flight-settings').replaceChildren(
  settingChoices('雙搖桿配置', 'stick-mode', [
    [2, '美國手 · Mode 2', '左手油門、右手俯仰'],
    [1, '日本手 · Mode 1', '右手油門、左手俯仰'],
  ], controls.stickMode, value => {
    input.clear();
    input.cancelCalibration();
    controls.stickMode = value;
    labelTouchControls();
    saveControls();
  }),
  settingChoices('飛行輔助', 'flight-assist', [
    [true, '初學自穩', '鬆桿後較快穩定'],
    [false, '進階操控', '傾斜時需自行補油門'],
  ], controls.stabilize, value => { controls.stabilize = value; saveControls(); }),
  advancedFlight,
);
$('sound-settings').replaceChildren(
  settingChoices('畫質', 'quality', [['low','省電'], ['medium','標準'], ['high','精細']],
    controls.quality, value => { controls.quality = value; view?.quality(value); saveControls(); }),
  check(controls, 'shake', '碰撞鏡頭震動', saveControls),
  range(controls, 'volume', '主音量', 0, 1, .05, saveControls),
  range(controls, 'effects', '音效音量', 0, 1, .05, saveControls),
  check(controls, 'muted', '靜音', saveControls),
  optionMenu('進球音效', [['horn','競技號角'], ['electronic','電子脈衝'], ['cheer','校園歡呼']], controls.sound,
    value => { controls.sound = value; saveControls(); }),
);
const saveTeacher = () => {
  store('teacher', course);
  if (local?.training) Object.assign(local.training.settings, course);
};
$('teacher-settings').replaceChildren(
  range(course, 'pass', 'PASS 門檻', 75, 100, 1, saveTeacher),
  range(course, 'collisionPenalty', '碰撞扣分', 0, 8, 1, saveTeacher),
  range(course, 'timeScale', '限時倍率', .75, 2, .05, saveTeacher),
  check(course, 'hints', '顯示訓練提示球', saveTeacher),
);
const controllerMeters = padBindings.map(({ key, name }) => {
  const label = make('label', name);
  const value = make('output', '0.00');
  const meter = make('meter', '', { min: '-1', max: '1', value: '0' });
  label.append(value, meter);
  $('pad-meters').append(label);
  return { key, value, meter };
});

function updateControllerPanel() {
  const pad = input.pad;
  const devices = input.devices;
  const chosen = input.selectedKey;
  const signature = JSON.stringify([chosen, devices, pad?.axes.length]);
  if (signature !== controllerSignature) {
    controllerSignature = signature;
    $('pad-device').replaceChildren(make('option', '自動偵測', { value: '' }), ...devices.map(device =>
      make('option', device.id || '控制器 ' + (device.index + 1), { value: device.key })));
    $('pad-device').value = chosen;
    $('pad-device').disabled = !devices.length;
    $('pad-pairing').open = !pad;
    renderPadSettings();
  }
  const ready = Boolean(input.profile);
  const descriptor = pad ? (pad.id || '遊戲控制器') + ' · ' + pad.axes.length + ' 軸 · ' +
    (ready ? '可操作' : pad.axes.length < 4 ? '需至少四軸' : '請校正') : input.padError ?? '';
  setText($('pad-description'), descriptor || '等待控制器。配對後請動一下搖桿或按鍵。');
  const calibration = input.calibration;
  const running = calibration && !calibration.done && !calibration.error;
  $('pad-calibrate').disabled = !pad || pad.axes.length < 4 || Boolean(running);
  $('pad-cancel').hidden = !running;
  $('pad-meters').hidden = !pad || !ready;
  $('pad-advanced').hidden = !pad || Boolean(running);
  if (calibration) {
    const state = calibration.error || (calibration.done ? '四軸校正完成。移動搖桿可查看即時輸入。' :
      calibration.returning ? '把搖桿放回中央。' : (calibration.axes.length + 1) + '／4　' +
        padInstruction(calibration.axes.length, controls.stickMode) + '，其他搖桿保持置中。');
    if (calibrationState !== state) {
      calibrationState = state;
      setText($('pad-detect'), state);
      if (calibration.done) renderPadSettings();
    }
  }
  if (!pad || !ready) return;
  const values = padValues(input.profile, pad.axes);
  for (const { key, value, meter } of controllerMeters) {
    const amount = values[key];
    meter.value = amount;
    setText(value, amount.toFixed(2));
  }
}

function renderPadSettings() {
  if (!input.pad) {
    $('pad-settings').replaceChildren();
    return;
  }
  const profile = input.editProfile();
  const save = () => input.saveProfile(profile);
  const axes = Array.from({ length: input.pad.axes.length }, (_, number) => [number, '軸 ' + (number + 1)]);
  const widgets = padBindings.map(({ name }, index) => {
    const group = make('div');
    group.append(optionMenu(name + '軸', axes, profile.axes[index], value => {
      profile.axes[index] = Number(value);
      profile.centers[index] = 0;
      save();
    }), check(profile.reverse, index, '反轉', save),
    button('偵測' + name, () => {
      const detected = input.detect(index, number => {
        setText($('pad-detect'), name + '已配對軸 ' + (number + 1));
        renderPadSettings();
      });
      setText($('pad-detect'), detected ? '請移動「' + name + '」對應的搖桿。' : '尚未讀到已連線手把。');
    }));
    return group;
  });
  $('pad-settings').replaceChildren(range(profile, 'deadzone', '搖桿死區', 0, .3, .01, save), ...widgets);
}
$('pad-device').onchange = () => {
  input.choosePad($('pad-device').value);
  setText($('pad-detect'), '');
};
$('pad-calibrate').onclick = () => {
  if (!input.startCalibration()) return;
  calibrationState = undefined;
  updateControllerPanel();
};
$('pad-cancel').onclick = () => {
  input.cancelCalibration();
  setText($('pad-detect'), '已取消校正。');
};
$('pad-center').onclick = () => {
  setText($('pad-detect'), input.center() ? '已記錄四軸中位。' : '尚未讀到已連線手把。');
  renderPadSettings();
};
$('pad-clear').onclick = () => {
  input.cancelCalibration();
  input.clearProfile();
  renderPadSettings();
  setText($('pad-detect'), '已清除這支控制器的個別校正。');
};

table($('rules-body'), [], [
  ['F9A-B 護框標稱 20 cm、上限 22 cm；含電池 ≤300 g', '使用直徑 20 cm 的球形碰撞體；重量為簡化模型參考值', '部分對照'],
  ['最多四個馬達、最高 4S、槳長上限 3 吋且禁金屬槳', '四旋翼視覺模型', '硬體規格參考'],
  ['標準飛行區 6 × 3 × 3 m', '預設 6 × 3 × 3 m；4 m 高與部分加寬訓練場', '符合／課程自訂'],
  ['球門建議外徑 70 cm、內徑 40 cm、厚度 ≤10 cm，底線內 1 m', '比賽使用 70／40／10 cm、離地 2 m 及底線內 1 m', '符合場地尺寸'],
  ['每隊 3–5 人，雙方人數相同。系列賽另見賽事公告', '3v3 或 5v5，空位由 AI 補上', '主辦單位可設定／課程 AI'],
  ['僅 Striker 可得分；整顆無人機向對手底線穿越', '檢查隊伍、角色、方向與完整穿越', '符合'],
  ['得分隊所有仍飛行的隊員回半場後才能再次進攻', '返回己方半場前鎖定得分資格', '符合'],
  ['三個 Set，各 3 分鐘；先贏兩局，局間通常 2–3 分鐘', '手動練習採 3 分鐘／休息 2 分鐘；本機可選 1 分鐘快打', '符合／課程自訂'],
  ['提前起飛、非法守門等由裁判處置；罰球 10 秒暫停 Set 時鐘', '簡化判罰流程，得分手對一名防守者', '規則練習'],
  ['允許飛手主動翻正；正式比賽限制自動定位與航線修正', 'T 可翻正，手動設定停用玩家飛行輔助', 'AI 僅供模擬練習'],
  ['平手處理依賽事公告', '採黃金進球', '課程自訂'],
]);

mountRulesLesson(level => {
  selectedLevel = level;
  store('level', level);
  $('rules-dialog').close();
  openMode('training');
});
matchOptions($('room-options'), true);
savedTrace().then(trace => { if (!previousTrace) previousTrace = trace; }).catch(() => {});
openMode('free');
lan.restore();
window.addEventListener('pagehide', () => {
  if (local?.trace?.goals.length) saveTrace(local.trace).catch(() => {});
});

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(.1, Math.max(0, (now - last) / 1000));
  last = now;
  const anyDialog = Boolean(document.querySelector('dialog[open]'));
  const blocked = anyDialog || replay.active;
  const viewingRules = $('rules-dialog').open;
  const values = input.poll(blocked);
  const partner = input.secondaryInput(blocked);
  if (mode === 'lan') lan.tick(now, values);
  else {
    lan.tick(now, null);
    accumulator += dt;
    while (accumulator >= STEP) {
      if (!viewingRules) tickGame(local, { [local.pilotId]: values, [secondPilotId]: partner }, STEP);
      accumulator -= STEP;
    }
    if (local.training && local.time - lastTrialSample >= .1) {
      lastTrialSample = local.time;
      const actor = local.drones[0];
      trainingPath.push({ id: '實飛', team: 1, role: 'striker', t: local.time, active: true,
        p: Object.values(actor.p), v: Object.values(actor.v), rotation: [actor.pitch, actor.yaw, actor.roll] });
    }
    if (local.trace && local.trace.goals.length) {
      const goal = local.trace.goals.at(-1);
      if (persisted < local.trace.goals.length * 2 - 1 ||
          persisted < local.trace.goals.length * 2 && (local.time > goal.t + 2.05 || local.phase === 'finished')) {
        persisted = local.trace.goals.length * 2 -
          (local.time > goal.t + 2.05 || local.phase === 'finished' ? 0 : 1);
        previousTrace = local.trace;
        saveTrace(local.trace).catch(() => {});
        if ($('replay-dialog').open) renderGoals();
      }
    }
  }
  const state = stateNow();
  const own = ownNow();
  events(state, own, now);
  if (now - lastHud > 70) { lastHud = now; updateHud(now); }
  if (replay.active) replay.tick(dt);
  else if (view && now - lastDraw >= (controls.quality === 'low' ? 28 : 14)) {
    const sinceDraw = Math.min(.1, (now - lastDraw) / 1000);
    lastDraw = now;
    view.draw(state, own, sinceDraw, { training: mode === 'training' ? local.training : null, hints: course.hints });
  }
}
requestAnimationFrame(frame);
