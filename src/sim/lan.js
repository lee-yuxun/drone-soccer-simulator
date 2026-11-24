import { $, button, make, read, store } from './browser.js';
import { ROLE_NAMES, rolesFor, TEAM_NAMES } from './config.js';

export function makeLan(onState, onMessage, options, controls) {
  let client;
  let member;
  let lobby;
  let latency = 0;
  let reconnect;
  let retryTimer;
  let lastPing = 0;
  let lastInput = 0;
  let wanted = null;
  const status = text => { $('lan-status').textContent = text; };
  const settings = () => ({
    sensitivity: controls.sensitivity, tilt: controls.tilt,
    thrust: controls.thrust, damping: controls.damping, stabilize: controls.stabilize,
  });
  const send = packet => {
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(packet));
  };
  function connect(packet) {
    if (client?.readyState === WebSocket.CONNECTING) {
      status('正連線至房主，請稍候。');
      return;
    }
    wanted = packet;
    if (client?.readyState === WebSocket.OPEN) {
      send(packet);
      return;
    }
    clearTimeout(retryTimer);
    const base = location.protocol === 'https:' ? 'wss:' : 'ws:';
    status('正連線至房主…');
    const socket = new WebSocket(base + '//' + location.host + '/room');
    client = socket;
    socket.addEventListener('open', () => {
      if (socket !== client) return;
      status('已連線。');
      if (wanted) send(wanted);
      wanted = null;
    });
    socket.addEventListener('message', event => {
      if (socket !== client) return;
      const message = JSON.parse(event.data);
      if (message.type === 'joined') {
        member = message.id;
        reconnect = { type: 'join', room: message.room, token: message.token };
        store('room', reconnect);
        send({ type: 'control', settings: settings() });
        status('已加入房間。');
      } else if (message.type === 'lobby') {
        lobby = message;
        render();
      } else if (message.type === 'state') {
        onState(message.state);
      } else if (message.type === 'pong') {
        latency = Math.round(performance.now() - message.now);
      } else if (message.type === 'error') {
        status(message.message);
        if (!member && reconnect) {
          reconnect = null;
          store('room', null);
        }
      } else {
        onMessage(message);
      }
    });
    socket.addEventListener('error', () => {
      if (socket === client) status('連線失敗。請核對 Wi‑Fi 網址、確認房主開啟區網模式，並允許防火牆連入。');
    });
    socket.addEventListener('close', () => {
      if (socket !== client) return;
      client = null;
      status(reconnect ? '連線中斷，正在重連。飛手席位暫時保留。' : '尚未連線至區網房主。');
      if (reconnect) retryTimer = setTimeout(() => connect(reconnect), 1700);
    });
  }
  function render() {
    $('lan-entry').hidden = Boolean(lobby);
    $('lan-lobby').hidden = !lobby;
    if (!lobby) return;
    const host = lobby.hostId === member;
    const own = lobby.members.find(seat => seat.id === member);
    $('lan-room').textContent = '房間 ' + lobby.room + ' · ' + lobby.size + 'v' + lobby.size +
      ' · 觀戰 ' + lobby.members.filter(seat => seat.team === null).length + ' 人';
    $('lan-ready').textContent = own?.ready ? '取消準備' : '準備';
    $('lan-ready').disabled = own?.team == null || lobby.running;
    $('lan-watch').disabled = own?.team == null || lobby.running;
    $('lan-start').hidden = !host;
    $('lan-start').disabled = lobby.running;
    $('room-options').hidden = !host;
    for (const input of $('room-options').querySelectorAll('select')) input.disabled = lobby.running;
    $('room-size').value = lobby.size;
    $('seats').replaceChildren(...[0, 1].map(team => {
      const group = make('div');
      group.append(make('h3', TEAM_NAMES[team]));
      for (const role of rolesFor(lobby.size)) {
        const seat = lobby.members.find(candidate => candidate.team === team && candidate.role === role);
        const label = ROLE_NAMES[role] + (seat ?
          ' · ' + (seat.id === member ? '你' : seat.id) + (seat.online ? seat.ready ? ' ✓' : '' : ' · 離線') : ' · 空位');
        const choose = button(label, () => send({ type: 'seat', team, role }), { 'aria-pressed': String(seat?.id === member) });
        choose.disabled = lobby.running || Boolean(seat && seat.id !== member);
        group.append(choose);
      }
      return group;
    }));
  }
  $('lan-create').onclick = () => connect({ type: 'create', size: Number($('lan-size').value) });
  $('lan-join-form').onsubmit = event => {
    event.preventDefault();
    connect({ type: 'join', room: $('lan-code').value.trim().toUpperCase() });
  };
  $('lan-watch').onclick = () => send({ type: 'seat', team: null });
  $('lan-ready').onclick = () => send({ type: 'ready' });
  $('lan-start').onclick = () => send({ type: 'start', ...options() });
  $('lan-leave').onclick = () => {
    send({ type: 'leave' });
    reconnect = null;
    store('room', null);
    member = null;
    lobby = null;
    clearTimeout(retryTimer);
    render();
    status('已離開房間。');
    onState(null);
  };
  return {
    get id() { return member; },
    get online() { return client?.readyState === WebSocket.OPEN; },
    get latency() { return latency; },
    restore() {
      const old = read('room', null);
      if (old) connect(old);
    },
    size(size) { send({ type: 'size', size }); },
    act(action) { send({ type: 'action', action }); },
    requestTrace(goalId, requestId) { send({ type: 'trace', goalId, requestId }); },
    requestSummary() { send({ type: 'summary' }); },
    updateControls() { send({ type: 'control', settings: settings() }); },
    tick(now, input) {
      if (!member) return;
      if (now - lastPing > 1300) { lastPing = now; send({ type: 'ping', now }); }
      if (input && now - lastInput > 32) {
        lastInput = now;
        send({ type: 'input', input });
      }
    },
  };
}
