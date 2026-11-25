import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, Scene, Vector3 } from 'three';
import { arenaDimensions, createArena } from '../src/models.js';
import { chasePose } from '../src/sim/view.js';
import { controlDefaults, goalAt, radius, STEP } from '../src/sim/config.js';
import { collideGoal, droneAt, neutral, point } from '../src/sim/flight.js';
import { doAction, gameCreate, tickGame } from '../src/sim/game.js';
import { evaluateTraining, levels, newTraining } from '../src/sim/training.js';
import { metrics, selectFrames } from '../src/sim/trace.js';

const run = (game, seconds, inputs) => {
  for (let step = 0; step < Math.round(seconds / STEP); step++) tickGame(game, inputs);
};
const seed = (drone, x, y, z, direction = 1) => {
  drone.p = point(x, y, z);
  drone.prev = { ...drone.p };
  drone.v = point(2.2 * direction, 0, 0);
  drone.armed = true;
  drone.crossing = {};
};

test('fixed-step flight takes off, hovers, moves, collides and lands', () => {
  const game = gameCreate();
  const drone = game.drones[0];
  const control = (axis, value) => ({ pilot: { ...neutral(), [axis]: value } });
  run(game, .5, control('throttle', 1));
  assert.equal(drone.p.y, .1);
  doAction(game, 'pilot', 'arm');
  run(game, .8, control('throttle', 1));
  assert.ok(drone.p.y > 1);
  run(game, 1.5);
  const height = drone.p.y;
  run(game, 1);
  assert.ok(Math.abs(drone.p.y - height) < .025);
  const x = drone.p.x;
  run(game, .35, control('pitch', 1));
  assert.ok(drone.p.x > x + .08);
  run(game, 2.5, control('roll', 1));
  assert.ok(drone.collisions >= 1);
  doAction(game, 'pilot', 'stop');
  run(game, 1.5);
  assert.equal(drone.p.y, .1);
  assert.equal(drone.armed, false);
});

test('scoring accepts clean full passage once and rejects reverse, partial, rim and wide paths', () => {
  const goal = goalAt(2);
  for (const [z, reverse, partial, expected] of [[0,false,false,1], [0,true,false,0], [0,false,true,0],
    [.14,false,false,0], [.59,false,false,0]]) {
    const drone = droneAt({ x: reverse ? 2.5 : 1.5, y: 2, z });
    let score = 0;
    const speed = reverse ? -.012 : .012;
    for (let i = 0; i < (partial ? 40 : 90); i++) {
      drone.prev = { ...drone.p };
      drone.p.x += speed;
      drone.nextContacts.clear();
      score += Number(collideGoal(drone, goal, .34));
    }
    assert.equal(score, expected, JSON.stringify({ z, reverse, partial }));
  }
});

test('Striker only, return lock, penalty and three separately recorded goals', () => {
  const game = gameCreate({ mode: 'match', settings: { setSeconds: 4, breakSeconds: 2 } });
  for (const [index, drone] of game.drones.entries()) {
    drone.ai = false;
    drone.p.z = index === 0 ? 0 : .6 + index * .12;
  }
  run(game, 3.01);
  assert.equal(game.phase, 'playing');
  const striker = game.drones[0];
  const other = game.drones[1];
  seed(other, 1.72, 2, 0);
  run(game, .42);
  assert.deepEqual(game.score, [0, 0]);
  seed(other, -1.1, .1, 1.15);
  other.armed = false;
  for (let goal = 1; goal <= 3; goal++) {
    seed(striker, 1.72, 2, 0);
    run(game, .42);
    assert.equal(game.score[0], goal);
    assert.equal(game.blocked[0], true);
    seed(striker, -.25, 1.5, 0);
    run(game, .12);
    assert.equal(game.blocked[0], false);
  }
  assert.equal(game.trace.goals.length, 3);
  assert.equal(new Set(game.trace.goals.map(goal => goal.goalId)).size, 3);
  for (const goal of game.trace.goals) {
    assert.equal(goal.player, striker.id);
    assert.ok(selectFrames(game.trace, goal, 'highlight').length > 3);
    assert.ok(Number.isFinite(metrics(game.trace, goal).length));
  }
  seed(striker, 1.72, 2, 0);
  run(game, .42);
  assert.equal(game.blocked[0], true);
  seed(striker, 1.72, 2, 0);
  run(game, .42);
  assert.equal(game.score[0], 4);
  assert.equal(game.penalties[0], 1);
  assert.equal(game.phase, 'penalty');
  const frozenClock = game.remaining;
  run(game, .4);
  assert.equal(game.remaining, frozenClock);
}, { timeout: 1000 });

test('two wins with intermission and subsequent countdown', () => {
  const game = gameCreate({ mode: 'match', settings: { setSeconds: .65, breakSeconds: .5 } });
  run(game, 3.01);
  game.drones.forEach(drone => { drone.ai = false; });
  seed(game.drones[0], 1.72, 2, 0);
  run(game, .7);
  assert.equal(game.phase, 'break');
  assert.equal(game.setNumber, 1);
  assert.deepEqual(game.sets, [[1, 0]]);
  run(game, .51);
  assert.equal(game.phase, 'countdown');
  assert.equal(game.setNumber, 2);
  run(game, 3.01);
  game.drones.forEach(drone => { drone.ai = false; });
  seed(game.drones[0], 1.72, 2, 0);
  run(game, .7);
  assert.equal(game.phase, 'finished');
  assert.deepEqual(game.wins, [2, 0]);
});

test('3v3 and 5v5 produce unique positions and one Striker per team', () => {
  for (const size of [3, 5]) {
    const game = gameCreate({ mode: 'lan', size });
    assert.equal(game.drones.length, size * 2);
    assert.equal(new Set(game.drones.map(drone => [drone.p.x, drone.p.z].join(','))).size, size * 2);
    for (const team of [0, 1]) assert.equal(game.drones.filter(drone => drone.team === team && drone.role === 'striker').length, 1);
  }
});

test('30 training definitions terminate once, keep coordinates inside their courts and compute a pass', () => {
  assert.equal(levels.length, 30);
  assert.equal(levels[6].stages.length, 5);
  for (const index of [1, 2]) {
    const level = levels[index];
    const [x, y, z] = level.start;
    assert.deepEqual(level.stages.at(-1).p, point(x, y, z));
  }
  for (const level of levels.slice(12, 14)) {
    assert.equal(level.stages.length, 33);
    assert.equal(new Set(level.stages.map(stage => stage.p.x)).size, 1);
    assert.ok(Math.max(...level.stages.map(stage => stage.p.y)) > 4);
  }
  for (const [index, level] of levels.entries()) {
    const state = newTraining(level, { pass: 92, collisionPenalty: 2, timeScale: 1 });
    const drone = droneAt({});
    drone.v = point();
    for (const stage of level.stages) {
      if (stage.p) {
        assert.ok(Math.abs(stage.p.x) < level.field.length / 2, 'x level ' + (index + 1));
        assert.ok(Math.abs(stage.p.z) < level.field.width / 2, 'z level ' + (index + 1));
        assert.ok(stage.p.y < level.field.height, 'y level ' + (index + 1));
        drone.p = stage.type === 'home' ? point(-.75, 1.3, 0) : stage.p;
        drone.yaw = stage.yaw ?? 0;
      }
      drone.yawDelta = 6.3 * (stage.direction ?? 0);
      state.recovered = true;
      state.checked = true;
      evaluateTraining(state, drone, [stage.gate], stage.seconds ?? STEP, true);
    }
    assert.equal(state.result?.pass, true, 'level ' + (index + 1));
    const result = state.result;
    assert.equal(evaluateTraining(state, drone, [], STEP, false), false);
    assert.equal(state.result, result);
  }
});

test('course waypoints accept swept crossings at any heading and keep explicit turns', () => {
  const settings = { pass: 92, collisionPenalty: 2, timeScale: 1 };
  const stage = levels[1].stages[0];
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const run = newTraining(levels[1], settings);
    const drone = droneAt({ yaw });
    drone.prev = point(stage.p.x - .5, stage.p.y, stage.p.z);
    drone.p = point(stage.p.x + .5, stage.p.y, stage.p.z);
    assert.equal(evaluateTraining(run, drone, [], STEP, false), true);
  }
  const turn = newTraining(levels[9], settings);
  turn.stage = 1;
  const drone = droneAt({});
  drone.p = turn.level.stages[1].p;
  assert.equal(evaluateTraining(turn, drone, [], STEP, false), false);
  drone.yaw = Math.PI;
  assert.equal(evaluateTraining(turn, drone, [], STEP, false), true);
});

test('Turtle drill and simulated continuous run-time gate training', () => {
  const turtle = gameCreate({ mode: 'training', level: 19 });
  const drone = turtle.drones[0];
  const start = { ...drone.p };
  assert.equal(drone.roll, 0);
  assert.equal(drone.flipped, false);
  run(turtle, .4);
  assert.ok(drone.roll > 0 && drone.roll < Math.PI);
  doAction(turtle, 'pilot', 'arm');
  doAction(turtle, 'pilot', 'turtle');
  assert.equal(drone.armed, false);
  assert.equal(drone.recovering, 0);
  run(turtle, .6);
  assert.equal(drone.flipped, true);
  assert.equal(drone.roll, Math.PI);
  assert.deepEqual(drone.p, start);
  assert.equal(turtle.training.elapsed, 0);
  assert.equal(turtle.training.stage, 0);
  doAction(turtle, 'pilot', 'turtle');
  doAction(turtle, 'pilot', 'arm');
  assert.equal(drone.armed, false);
  run(turtle, .71);
  assert.equal(drone.roll, 0);
  assert.equal(turtle.training.stage, 1);
  doAction(turtle, 'pilot', 'arm');
  run(turtle, .7, { pilot: { ...neutral(), throttle: .82 } });
  assert.ok(turtle.training.result?.pass);
  const gate = gameCreate({ mode: 'training', level: 9 });
  doAction(gate, 'pilot', 'arm');
  run(gate, 1, { pilot: { ...neutral(), throttle: .92 } });
  assert.equal(gate.training.started, true);
  seed(gate.drones[0], 1.72, 2, 0);
  run(gate, .43);
  assert.equal(gate.training.stage, 1);
  gate.drones[0].p = point(2.6, 2, 0);
  gate.drones[0].v = point();
  run(gate, 5.1);
  assert.ok(gate.training.result?.pass);
});

test('default frame tuning is stable and finite during an AI game', () => {
  const game = gameCreate({ mode: 'match', profileId: 'course-5v5', controls: controlDefaults });
  run(game, 38);
  for (const drone of game.drones) assert.ok(Object.values(drone.p).every(Number.isFinite));
  assert.ok(game.trace.samples.length > 3000);
  assert.ok(game.trace.goals.length > 0, 'AI must be able to complete an attack');
});

test('all thirty drills begin grounded and stay grounded before user input', () => {
  for (const [index, level] of levels.entries()) {
    const game = gameCreate({ mode: 'training', level: index + 1 });
    const drone = game.drones[0];
    assert.deepEqual(drone.p, point(level.start[0], radius, level.start[2]));
    assert.ok(game.drones.every(actor => !actor.armed && actor.p.y === radius));
    run(game, level.countdown ? 2.5 : 1);
    assert.equal(drone.p.y, radius);
    assert.equal(drone.v.y, 0);
    assert.equal(game.training.elapsed, 0);
    assert.equal(drone.armed, false);
  }
  const penalty = gameCreate({ mode: 'training', level: 25 });
  run(penalty, 3.4);
  assert.equal(penalty.training.started, true);
  assert.ok(penalty.training.elapsed > 0);
  assert.equal(penalty.drones[0].p.y, radius);
});

test('follow view stays directly behind the aircraft through any heading', () => {
  for (const position of [new Vector3(-1.45, .1, 0), new Vector3(2.87, 2.89, 1.32)]) {
    for (let n = 0; n < 24; n++) {
      const yaw = n * Math.PI / 12;
      const { eye, target } = chasePose(position, yaw, arenaDimensions);
      const offset = eye.clone().sub(position);
      const forward = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      assert.ok(offset.dot(forward) < -.44);
      assert.ok(Math.abs(offset.x * forward.z - offset.z * forward.x) < 1e-12);
      assert.ok(target.clone().sub(position).dot(forward) > 0);
    }
  }
});

test('turf and crossing pitch lines have separate visible surfaces', () => {
  const arena = createArena(new Scene());
  const height = name => new Box3().setFromObject(arena.getObjectByName(name)).max.y;
  assert.ok(height('Turf strip') - height('Turf') > .002);
  assert.ok(height('End line') - height('Turf strip') > .002);
  assert.ok(height('Touch line') - height('End line') > .001);
  assert.ok(height('Centre circle') - height('Halfway line') > .001);
});

test('a solo defender is controllable and keeps the role when the next set starts', () => {
  const game = gameCreate({ mode: 'match', pilotRole: 'defender', settings: { setSeconds: 2, breakSeconds: .5 } });
  const player = game.drones.find(drone => drone.id === 'pilot');
  const striker = game.drones.find(drone => drone.team === 0 && drone.role === 'striker');
  assert.equal(player.role, 'defender');
  assert.equal(player.ai, false);
  assert.equal(striker.ai, true);

  for (const drone of game.drones) drone.ai = false;
  run(game, 3.02);
  doAction(game, 'pilot', 'arm');
  run(game, .45, { pilot: { ...neutral(), throttle: 1 } });
  assert.ok(player.p.y > radius + .3);
  seed(player, 1.72, 2, 0);
  run(game, .42);
  assert.deepEqual(game.score, [0, 0]);

  seed(player, -2.6, radius, .45);
  player.armed = false;
  seed(striker, 1.72, 2, 0);
  run(game, .42);
  assert.deepEqual(game.score, [1, 0]);
  assert.equal(game.trace.goals[0].player, striker.id);
  run(game, .8);
  assert.equal(game.phase, 'break');
  run(game, .51);
  assert.equal(game.setNumber, 2);
  assert.equal(game.drones.find(drone => drone.id === 'pilot').role, 'defender');
  assert.equal(game.drones.find(drone => drone.team === 0 && drone.role === 'striker').ai, true);
});

test('shared matches give player 2 independent controls and a valid role', () => {
  for (const matchKind of ['versus', 'coop']) {
    const game = gameCreate({ mode: 'match', matchKind, pilotRole: 'defender', settings: { setSeconds: 60 } });
    const red = game.drones.find(drone => drone.id === 'pilot');
    const partner = game.drones.find(drone => drone.id === 'pilot-2');
    assert.equal(red.role, 'defender');
    assert.equal(partner.role, 'striker');
    assert.equal(partner.team, matchKind === 'versus' ? 1 : 0);
    assert.equal(partner.ai, false);
    assert.equal(game.drones.filter(drone => drone.team === partner.team && drone.role === 'striker').length, 1);
    for (const drone of game.drones) drone.ai = false;
    run(game, 3.02);
    doAction(game, 'pilot-2', 'arm');
    run(game, .7, { 'pilot-2': { ...neutral(), throttle: 1 } });
    assert.ok(partner.p.y > .65);
    assert.equal(red.p.y, .1);
    assert.ok(game.remaining < 60);
  }
});
