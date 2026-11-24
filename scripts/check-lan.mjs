import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const clients = [];
const connectUrl = process.argv[2] ?? process.env.SIM_WS_URL ?? 'ws://127.0.0.1:8766/room';
async function connect() {
  const socket = new WebSocket(connectUrl);
  const messages = [];
  const client = {socket, messages, send: packet => socket.send(JSON.stringify(packet)),
    wait: async (type, predicate = () => true) => {
      const deadline = Date.now() + 11000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(message => message.type === type && predicate(message));
        if (index !== -1) return messages.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 35));
      }
      throw Error('Timed out waiting for ' + type + ': ' + JSON.stringify(messages.slice(-4).map(({type,message,room}) => ({type,message,room}))));
    },
  };
  socket.on('message', wire => {
    messages.push(JSON.parse(wire.toString()));
    if (messages.length > 240) messages.shift();
  });
  clients.push(client);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return client;
}
async function match(size) {
  const host = await connect();
  host.send({type:'create',size});
  const room = await host.wait('joined');
  const players = [host, ...await Promise.all(Array.from({length:size*2-1}, connect))];
  const spectator = await connect();
  const join = async client => {
    client.send({type:'join',room:room.room});
    return client.wait('joined');
  };
  const ids = [room, ...await Promise.all(players.slice(1).map(join))];
  await join(spectator);
  const roles = size === 3 ? ['striker','support','defender'] : ['striker','left','right','sweeper','defender'];
  host.send({type:'seat',team:0,role:'striker'});
  await host.wait('lobby', data => data.members.some(seat => seat.id===ids[0].id && seat.role==='striker'));
  players[1].send({type:'seat',team:0,role:'striker'});
  assert.match((await players[1].wait('error')).message,/席位/);
  players.slice(1).forEach((client,index) => client.send({type:'seat',team:Math.floor((index+1)/size),role:roles[(index+1)%size]}));
  await host.wait('lobby', data => data.members.filter(seat=>seat.role).length===size*2);
  players.forEach(client => client.send({type:'ready'}));
  await host.wait('lobby', data => data.members.filter(seat=>seat.ready).length===size*2);
  host.send({type:'start',profileId:'course-' + size + 'v' + size});
  const active = await host.wait('state', packet=>packet.state.phase==='playing');
  assert.equal(active.state.drones.length,size*2);
  assert.ok(active.state.drones.every(drone=>!drone.ai));
  host.send({type:'action',action:'arm'});
  for (let i=0;i<21;i++) {
    host.send({type:'input',input:{throttle:1,yaw:0,pitch:0,roll:0}});
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  await spectator.wait('state', packet=>packet.state.drones.find(drone=>drone.id===room.id).p.y>.65);
  if (size === 5) {
    const clamp = value => Math.min(1, Math.max(-1, value));
    for (let attempt = 0; attempt < 190; attempt++) {
      const {state} = await host.wait('state', data => data.state.phase === 'playing');
      if (state.score[0] === 1) break;
      if (attempt === 189) throw Error('Authority did not register the client-controlled goal');
      const drone = state.drones.find(value => value.id === room.id);
      const altitude = Math.abs(drone.p.y - 2) < .022 && Math.abs(drone.v.y) < .15;
      const x = altitude || drone.p.x > .7 ? 2.36 : .65;
      host.send({type:'input',input:{
        throttle:clamp((2-drone.p.y)*1.8-drone.v.y*.55),
        pitch:clamp((x-drone.p.x)*1.4-drone.v.x*.45),roll:0,yaw:0
      }});
    }
    const packet = await spectator.wait('state', data=>data.state.score[0]===1);
    const scored = packet.state.traceGoals[0];
    host.send({type:'trace',goalId:scored.goalId,requestId:87});
    const reply = await host.wait('trace', data=>data.requestId===87);
    assert.equal(reply.full,false);
    assert.equal(reply.trace.goals[0].goalId,scored.goalId);
    assert.ok(reply.trace.samples.length>0);
    assert.ok(reply.trace.goals[0].highlight.length>0);
  }
  const left = players.at(-1);
  left.socket.close();
  const saved = ids.at(-1);
  await host.wait('lobby', data=>data.members.some(seat=>seat.id===saved.id && !seat.online));
  const restored = await connect();
  restored.send({type:'join',room:room.room,token:saved.token});
  assert.equal((await restored.wait('joined')).id,saved.id);
  await restored.wait('state', data=>data.state.drones.some(drone=>drone.id===saved.id && !drone.ai));
  for (const client of [...players,spectator,restored]) client.socket.close();
  console.log(size+'v'+size+': '+(size*2)+' active clients + spectator, unique seat locks, ready, authoritative takeoff sync, reconnect.' + (size === 5 ? ' Full goal and trajectory passed.' : ''));
}
try { await match(3); await match(5); } finally {
  for (const client of clients) client.socket.close();
}
