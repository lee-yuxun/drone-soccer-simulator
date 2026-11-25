import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
const debugUrl = process.env.SIM_CHROME_DEBUG_URL ?? 'http://127.0.0.1:9225';
const simUrl = process.env.SIM_URL ?? 'http://127.0.0.1:8766/';
const pages = await (await fetch(new URL('/json/list', debugUrl))).json();
const page = pages.find(entry => entry.type === 'page');
assert.ok(page, 'Start a dedicated Chrome QA profile with a remote debugging port.');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, {once: true});
  socket.addEventListener('error', reject, {once: true});
});
let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', ({data}) => {
  const message = JSON.parse(data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map(argument => argument.value ?? argument.description));
  }
  if (message.id && pending.has(message.id)) {
    const [resolve, reject] = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(message.error);
    else resolve(message.result);
  }
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, [resolve, reject]);
  socket.send(JSON.stringify({id, method, params}));
});
const evaluate = async (expression) => {
  const response = await command('Runtime.evaluate', {expression, returnByValue: true});
  if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
async function waitUntil(condition, label, wait = 14000) {
  const end = Date.now() + wait;
  while (Date.now() < end) {
    if (await evaluate(condition)) return;
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error(label + '\n' + await evaluate("document.body.innerText.slice(0,1100)"));
}
async function capture(name) {
  const result = await command('Page.captureScreenshot', {format: 'png'});
  await writeFile(join(tmpdir(), 'drone-soccer-game-' + name + '.png'), Buffer.from(result.data, 'base64'));
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const key = (code, key, keyCode, type) => command('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: keyCode });
const tap = async (code, name, keyCode) => {
  await key(code, name, keyCode, 'keyDown');
  await key(code, name, keyCode, 'keyUp');
};
const select = async (id, value) => evaluate(`{ const node = document.getElementById('${id}');node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change')); }`);
try {
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Log.enable');
  await command('Emulation.setDeviceMetricsOverride', {width: 1366, height: 768, deviceScaleFactor: 1, mobile: false});
  const navigation = await command('Page.navigate', {url: simUrl});
  assert.equal(navigation.errorText, undefined);
  await waitUntil("!!document.querySelector('#stage canvas')", 'WebGL canvas never loaded');
  assert.equal(await evaluate("document.querySelector('.rail') === null"), true);
  await waitUntil("document.querySelector('#camera').value === 'follow'", 'Rear follow view should be selected at startup');
  await capture('free');
  await click('#arm');
  await key('KeyW', 'w', 87, 'keyDown');
  await waitUntil("+document.querySelector('#altitude').textContent > .75", 'Keyboard throttle did not take off');
  await key('KeyW', 'w', 87, 'keyUp');
  await key('KeyD', 'd', 68, 'keyDown');
  await new Promise(resolve => setTimeout(resolve, 340));
  await key('KeyD', 'd', 68, 'keyUp');
  await capture('follow');
  await key('ArrowUp', 'ArrowUp', 38, 'keyDown');
  await waitUntil("+document.querySelector('#speed').textContent > .5", 'Pitch did not accelerate');
  await key('ArrowUp', 'ArrowUp', 38, 'keyUp');
  await tap('KeyZ', 'z', 90);
  await waitUntil("document.querySelector('#altitude').textContent === '0.10'", 'Keyboard reset did not restore takeoff');
  await click('[data-mode=training]');
  await select('level', '2');
  assert.equal(await evaluate("!document.querySelector('.viewport #training-strip').hidden && " +
    "document.querySelector('#training-help').textContent.includes('朝前飛')"), true);
  await new Promise(resolve => setTimeout(resolve, 350));
  await waitUntil("document.querySelector('#altitude').textContent === '0.10' && document.querySelector('#training-strip').textContent.includes('垂直起飛')",
    'Airborne drill should wait grounded until the pilot takes off');
  await select('level', '19');
  await waitUntil("document.querySelector('#training-strip').textContent.includes('正在原地翻覆')",
    'Turtle drill should show the in-place tip');
  await waitUntil("!document.querySelector('#turtle').disabled && document.querySelector('#arm').disabled",
    'Turtle drill should wait upside down with motors locked');
  await tap('KeyT', 't', 84);
  await waitUntil("document.querySelector('progress').value === 1", 'Turtle recovery did not count');
  await click('#arm');
  await key('KeyW', 'w', 87, 'keyDown');
  await waitUntil("document.querySelector('.result')?.textContent.includes('PASS')", 'Turtle drill did not pass');
  await key('KeyW', 'w', 87, 'keyUp');
  await capture('training');
  await waitUntil("!document.querySelector('.viewport #training-result').hidden && " +
    "[...document.querySelectorAll('#training-result button')].map(button => button.textContent).join() === '下一關,再試一次'",
    'Passed drill should automatically show next and retry in the flight view');
  await click('#training-result .primary');
  await waitUntil("document.querySelector('#level').value === '20' && document.querySelector('#training-result').hidden",
    'Next should load the next drill and clear the last result');
  await click('[data-dialog=flight-dialog]');
  await waitUntil("document.querySelector('#flight-dialog').open", 'Flight information did not open');
  await click('[data-dialog=records-dialog]');
  await waitUntil("document.querySelector('#record-table')?.textContent.includes('PASS')", 'Training result not stored');
  await click('#records-dialog [data-close]');
  await click('#flight-dialog [data-close]');
  await select('level', '25');
  await waitUntil("!document.querySelector('#training-result').hidden && " +
    "document.querySelector('#training-result h2').textContent.includes('未通過')",
    'Timed-out drill should automatically show its result', 60000);
  assert.equal(await evaluate("[...document.querySelectorAll('#training-result button')].map(button => button.textContent).join()"),
    '再試一次');
  await click('#training-result .primary');
  await waitUntil("document.querySelector('#level').value === '25' && document.querySelector('#training-result').hidden && " +
    "document.querySelector('#banner').textContent.includes('準備起飛')", 'Retry should restart the same drill');
  await click('[data-dialog=settings-dialog]');
  await waitUntil("document.querySelector('#settings-dialog').open && document.querySelector('[data-stick-mode]')", 'Pilot settings missing');
  await click('[data-settings=media]');
  assert.equal(await evaluate("!document.getElementById('settings-media').hidden"), true);
  await click('[data-settings=course]');
  assert.equal(await evaluate("!document.getElementById('settings-course').hidden"), true);
  await click('[data-settings=pilot]');
  await click('#settings-dialog [data-close]');
  await click('[data-mode=match]');
  await waitUntil("document.querySelector('#match-start-dialog').open", 'Role picker did not open');
  await click('#match-start-form input[value=solo]');
  await click('#match-start-form input[value=striker]');
  await click('#match-start-form button[type=submit]');
  await waitUntil("document.querySelector('#role-tag').textContent.includes('得分手')", 'Striker role did not start');
  await click('[data-mode=match]');
  await click('#match-start-form input[value=defender]');
  await click('#match-start-form button[type=submit]');
  await waitUntil("document.querySelector('#role-tag').textContent.includes('防守') && document.querySelector('#camera').value === 'follow'",
    'Defender role or rear chase camera was not active');
  await waitUntil("document.querySelector('#time-label').textContent.includes('SET 1')", 'Match countdown did not become active');
  await capture('match');
  await waitUntil("['red-score','blue-score'].some(id=>Number(document.getElementById(id).textContent)>0)", 'AI did not score in browser', 45000);
  await click('[data-dialog=replay-dialog]');
  await waitUntil("!!document.querySelector('#goal-list button')", 'Goal not visible in replay list');
  await click('#goal-list button');
  await waitUntil("!document.querySelector('#replay-controls').hidden", 'Goal replay did not open');
  await click('#replay-play');
  await waitUntil("parseFloat(document.querySelector('#replay-clock').value) > .1", 'Replay playback did not advance');
  await capture('replay');
  await click('#replay-close');
  await waitUntil("document.querySelector('#camera').value === 'follow'", 'Rear follow view should resume after replay');
  await click('[data-mode=match]');
  await click('#match-start-form input[value=versus]');
  await select('match-round', '60');
  await click('#match-start-form button[type=submit]');
  await waitUntil("document.getElementById('shared-status').textContent.includes('藍隊') && " +
    "document.getElementById('camera').value === 'sideline'", 'Same-device versus did not start');
  await waitUntil("document.getElementById('time-label').textContent.includes('SET 1')", 'Versus whistle did not fire');
  await tap('KeyM', 'm', 77);
  await key('KeyI', 'i', 73, 'keyDown');
  await waitUntil("parseFloat(document.getElementById('shared-status').textContent.split('高度 ')[1]) > .65 && " +
    "document.getElementById('altitude').textContent === '0.10'", 'Player 2 did not fly independently');
  await key('KeyI', 'i', 73, 'keyUp');
  await click('[data-mode=match]');
  await click('#match-start-form input[value=coop]');
  await click('#match-start-form button[type=submit]');
  await waitUntil("document.getElementById('shared-status').textContent.includes('紅隊')", 'Cooperation did not assign both players to red');
  await click('[data-dialog=rules-dialog]');
  await waitUntil("document.querySelectorAll('#rules-chapters button').length === 5", 'Rule chapters are missing');
  await click('#rules-chapters button:nth-child(2)');
  await click('#rules-play');
  await waitUntil("Number(document.getElementById('rules-timeline').value) > 3", 'Rule animation did not advance');
  await click('#rules-play');
  const stopped = await evaluate("document.getElementById('rules-timeline').value");
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(await evaluate("document.getElementById('rules-timeline').value"), stopped);
  await evaluate("const slider=document.getElementById('rules-timeline'); slider.value=92; slider.dispatchEvent(new Event('input'));");
  await waitUntil("document.getElementById('rules-demo-caption').textContent.includes('＋1 分')", 'Goal demo missed its final state');
  await click('#rules-answers button:first-child');
  await waitUntil("document.getElementById('rules-feedback').dataset.correct === 'true'", 'Rule quiz did not grade');
  await capture('rules');
  await click('#rules-practice');
  await waitUntil("!document.getElementById('rules-dialog').open && document.getElementById('level').value === '9'",
    'Rule practice did not start the real flight drill');
  if (await evaluate("!document.querySelector('[data-dialog=lan-dialog]').hidden")) {
    await click('[data-dialog=lan-dialog]');
    await click('#lan-create');
    await waitUntil("!document.querySelector('#lan-lobby').hidden", 'Browser room failed');
    await click('#lan-leave');
    await click('#lan-dialog [data-close]');
  } else {
    await click('[data-mode=free]');
  }
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  async function touchLayout(width, height) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await evaluate("window.scrollTo({top:0,behavior:'instant'})");
    await waitUntil(`innerWidth === ${width} && !document.getElementById('small-sticks').hidden &&
      document.documentElement.scrollWidth <= ${width}`, 'Touch layout did not fit');
    const rect = id => evaluate(`document.getElementById('${id}').getBoundingClientRect().toJSON()`);
    const [left, right] = await Promise.all([rect('left-pocket'), rect('right-pocket')]);
    assert.ok(left.right < width / 2 && right.left > width / 2, 'Each thumb should have a separate side');
    assert.ok(left.width >= 82 && right.width >= 82, 'Touch targets are too small');
    return { left, right };
  }
  const portrait = await touchLayout(390, 844);
  await click('#arm');
  const touch = (rect, id, x, y) => ({ id, x: Math.floor(rect.x + rect.width * x),
    y: Math.floor(rect.y + rect.height * y) });
  const left = touch(portrait.left, 1, .5, .18);
  const right = touch(portrait.right, 2, .81, .5);
  assert.equal(await evaluate(`document.elementFromPoint(${left.x}, ${left.y})?.id`), 'left-pocket');
  assert.equal(await evaluate(`document.elementFromPoint(${right.x}, ${right.y})?.id`), 'right-pocket');
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [left, right] });
  await waitUntil("document.querySelectorAll('.stick[data-held]').length === 2 && " +
    "Number(document.getElementById('altitude').textContent) > .65 && " +
    "Number(document.getElementById('right-stick').style.getPropertyValue('--stick-x')) > .3",
  'Two touch inputs should steer and lift simultaneously');
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitUntil("!document.querySelector('.stick[data-held]')", 'Touch inputs did not return to neutral');
  await click('[data-dialog=settings-dialog]');
  await click('[data-stick-mode="1"]');
  await click('#settings-dialog [data-close]');
  await click('#reset');
  await click('#arm');
  const stage = await evaluate("document.getElementById('stage').getBoundingClientRect().toJSON()");
  const origins = [touch(stage, 13, .30, .47), touch(stage, 14, .72, .47)];
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: origins });
  await waitUntil("!document.getElementById('left-float').hidden && !document.getElementById('right-float').hidden",
    'Floating pads did not appear at independent touch points');
  await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
    { ...origins[0], x: origins[0].x + 24 }, { ...origins[1], y: origins[1].y - 40 },
  ] });
  await waitUntil("Number(document.getElementById('altitude').textContent) > .65",
    'Mode 1 floating right stick did not control throttle');
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitUntil("document.getElementById('left-float').hidden && document.getElementById('right-float').hidden",
    'Floating pads did not release');
  await click('[data-dialog=settings-dialog]');
  await click('[data-stick-mode="2"]');
  await click('#settings-dialog [data-close]');
  await capture('narrow');
  await touchLayout(844, 390);
  await capture('landscape');
  await touchLayout(834, 1194);
  await capture('tablet');
  await click('#virtual-controls');
  assert.equal(await evaluate("document.getElementById('small-sticks').hidden"), true);
  await click('#virtual-controls');
  await click('#reset');

  await evaluate(`
    window.testPad = {id:'ELRS mock ' + crypto.randomUUID(), index:0, mapping:'', connected:true, axes:[0,0,0,0,1,-1], buttons:[]};
    Object.defineProperty(navigator,'getGamepads', { configurable:true, value:()=>window.testPad?.connected ? [window.testPad] : [] });
  `);
  await click('#controller-button');
  await waitUntil("document.getElementById('pad-description').textContent.includes('ELRS mock') && " +
    "document.getElementById('pad-description').textContent.includes('請校正')", 'Generic ELRS controller was not recognized');
  await click('#pad-calibrate');
  for (const [step, [axis, value]] of [[3,-.9],[2,.9],[0,.9],[1,-.9]].entries()) {
    await waitUntil(`document.getElementById('pad-detect').textContent.includes('${step+1}／4')`, 'Wrong calibration step');
    await evaluate(`window.testPad.axes[${axis}]=${value}`);
    await waitUntil("document.getElementById('pad-detect').textContent.includes('放回中央')", 'Axis movement was not captured');
    await evaluate(`window.testPad.axes[${axis}]=0`);
  }
  await waitUntil("document.getElementById('pad-detect').textContent.includes('四軸校正完成') && " +
    "!document.getElementById('pad-meters').hidden", 'ELRS calibration did not complete');
  await click('#controller-dialog [data-close]');
  await click('#arm');
  await evaluate('window.testPad.axes[2]=.94');
  await waitUntil("Number(document.getElementById('altitude').textContent) > .65", 'Calibrated ELRS throttle did not take off');
  await evaluate('window.testPad.connected=false');
  await waitUntil("!document.getElementById('controller-button').hasAttribute('data-connected') && " +
    "Number(document.getElementById('left-stick').style.getPropertyValue('--stick-y')) === 0",
  'Disconnect should clear the selected controller input');
  assert.deepEqual(errors, []);
  console.log('Chrome: default rear chase, solo striker and defender selection, grounded training, same-device versus and co-op, animated rules, quiz and real practice, fixed and floating dual touch in Mode 1/2, ELRS calibration and disconnect, and goal replay; no rendering or runtime errors.');
} finally {
  socket.close();
}
