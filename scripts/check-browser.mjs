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
  await new Promise(resolve => setTimeout(resolve, 350));
  await waitUntil("document.querySelector('#altitude').textContent === '0.10' && document.querySelector('#training-strip').textContent.includes('垂直起飛')",
    'Airborne drill should wait grounded until the pilot takes off');
  await select('level', '19');
  await click('#turtle');
  await waitUntil("document.querySelector('progress').value === 1", 'Turtle recovery did not count');
  await click('#arm');
  await key('KeyW', 'w', 87, 'keyDown');
  await waitUntil("document.querySelector('.result')?.textContent.includes('PASS')", 'Turtle drill did not pass');
  await key('KeyW', 'w', 87, 'keyUp');
  await capture('training');
  await click('[data-dialog=flight-dialog]');
  await waitUntil("document.querySelector('#flight-dialog').open", 'Flight information did not open');
  await click('[data-dialog=records-dialog]');
  await waitUntil("document.querySelector('#record-table')?.textContent.includes('PASS')", 'Training result not stored');
  await click('#records-dialog [data-close]');
  await click('#flight-dialog [data-close]');
  await click('[data-dialog=settings-dialog]');
  await waitUntil("document.querySelector('#settings-dialog').open && document.querySelector('#flight-settings input')", 'Settings missing');
  await click('#settings-dialog [data-close]');
  await click('[data-mode=match]');
  await waitUntil("document.querySelector('#match-start-dialog').open", 'Role picker did not open');
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
  await click('[data-dialog=lan-dialog]');
  await click('#lan-create');
  await waitUntil("!document.querySelector('#lan-lobby').hidden", 'Browser room failed');
  await click('#lan-leave');
  await click('#lan-dialog [data-close]');
  await command('Emulation.setDeviceMetricsOverride', {width: 390, height: 800, deviceScaleFactor: 1, mobile: true});
  await command('Emulation.setTouchEmulationEnabled', {enabled:true, maxTouchPoints:2});
  await waitUntil("innerWidth === 390 && document.documentElement.scrollWidth <= 390 && !!document.querySelector('#small-sticks #left-pocket')",
    'Narrow screen overflow or virtual sticks not in viewport');
  await click('#arm');
  const stick = await evaluate("document.querySelector('#left-pocket').scrollIntoView({block:'center',behavior:'instant'}); JSON.stringify(document.querySelector('#left-pocket').getBoundingClientRect())");
  const rect = JSON.parse(stick);
  const point = {x:Math.floor(rect.x+rect.width/2),y:Math.floor(rect.y+rect.height*.19)};
  assert.equal(await evaluate(`document.elementFromPoint(${point.x}, ${point.y})?.id`), 'left-pocket');
  await command('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point]});
  await waitUntil("+document.querySelector('#altitude').textContent > .65", 'Virtual throttle did not respond');
  await command('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
  await capture('narrow');
  assert.deepEqual(errors, []);
  console.log('Chrome: default rear chase, solo striker and defender selection, grounded training, keyboard and touch takeoff, and goal replay; no rendering or runtime errors.');
} finally {
  socket.close();
}
