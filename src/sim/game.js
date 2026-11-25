import { controlDefaults, courseDefaults, field, profiles, radius, rolesFor, secondPilotId, standardGoals, STEP } from './config.js';
import { autopilot, boundDrone, clamp, collideDrones, collideGoal, distance, droneAt, neutral, point,
  goalCoordinate, stepDrone, turtle } from './flight.js';
import { evaluateTraining, levels, newTraining, tipDuration } from './training.js';
import { newTrace, recordFrame, recordGoal } from './trace.js';

const randomId = () => globalThis.crypto?.randomUUID?.() ?? (Date.now() + '-' + Math.random().toString(36).slice(2));
const homeSide = team => team === 0 ? -1 : 1;
const inHome = drone => drone.p.x * homeSide(drone.team) >= radius;
const timeValid = phase => ['playing', 'golden', 'penalty'].includes(phase);

function emit(game, type, data = {}) {
  const event = { id: game.id + ':' + ++game.eventId, type, t: game.time, ...data };
  game.events.push(event);
  if (game.events.length > 100) game.events.shift();
  if (game.trace && game.trace.events.length < 20000) game.trace.events.push(event);
  return event;
}

export function gameCreate(options = {}) {
  const { mode = 'free', level = 1, profileId = 'course-3v3', pilotId = 'pilot', roster = [],
    pilotRole, controls, course, settings, difficulty = 'normal', size } = options;
  const profile = profiles[profileId] ?? profiles['course-3v3'];
  const practice = mode === 'training' ? levels[clamp(level - 1, 0, levels.length - 1)] : null;
  const match = mode === 'match' || mode === 'lan';
  const teamSize = size === 5 ? 5 : size === 3 ? 3 : profile.teamSize;
  const game = {
    id: randomId(), options, mode, pilotId, profileId, teamSize, difficulty, match, practice,
    pilotRole: pilotRole === 'defender' ? 'defender' : 'striker',
    matchKind: ['versus', 'coop'].includes(options.matchKind) ? options.matchKind : 'solo',
    field: practice?.field ?? { ...field, height: settings?.height === 4 && !profile.manual ? 4 : field.height },
    goals: practice?.goals ?? standardGoals(field.length),
    controls: { ...controlDefaults, ...controls }, manual: match && profile.manual,
    setSeconds: profile.manual ? profile.setSeconds : settings?.setSeconds ?? profile.setSeconds,
    breakSeconds: profile.manual ? profile.breakSeconds : settings?.breakSeconds ?? profile.breakSeconds,
    events: [], eventId: 0, time: 0, phase: 'playing', remaining: 0, paused: false,
    setNumber: 1, score: [0, 0], wins: [0, 0], sets: [], blocked: [false, false],
    attackStart: [0, 0], penalties: [0, 0], penaltyQueue: [], penalty: null, seatSettings: {},
    training: practice ? newTraining(practice, { ...courseDefaults, ...course }) : null,
  };
  game.drones = createRoster(game, roster);
  if (match) {
    game.phase = 'countdown';
    game.remaining = 3;
    game.trace = newTrace(game);
  } else if (practice?.countdown) {
    game.phase = practice.stages[0]?.type === 'check' ? 'inspection' : 'countdown';
    game.remaining = practice.countdown;
  }
  return game;
}

function createRoster(game, roster) {
  if (game.match) {
    const localRoster = game.mode === 'match' ? [{ id: game.pilotId, team: 0, role: game.pilotRole }] : roster;
    if (game.mode === 'match' && game.matchKind !== 'solo') {
      const versus = game.matchKind === 'versus';
      localRoster.push({ id: secondPilotId, team: versus ? 1 : 0,
        role: versus || game.pilotRole === 'defender' ? 'striker' : 'defender' });
    }
    return [0, 1].flatMap(team => rolesFor(game.teamSize).map((role, slot) => {
      const player = localRoster.find(seat => seat.team === team && seat.role === role);
      const sign = homeSide(team);
      return droneAt({ id: player?.id ?? 'AI-' + team + '-' + role, team, role, ai: !player,
        x: (slot === 0 ? 1.32 : 2.72 - .26 * Math.floor((slot - 1) / 2)) * sign,
        y: radius, z: slot === 0 ? 0 : (slot % 2 ? -.45 : .45) * (slot > 2 ? 2 : 1),
        yaw: team ? Math.PI : 0,
      });
    }));
  }
  const start = game.practice?.start ?? [-1.45, radius, 0, 0];
  const [x, , z, yaw] = start;
  const player = droneAt({ id: game.pilotId, x, y: radius, z, yaw });
  if (game.practice?.opponent) {
    const attacking = game.practice.opponent === 'attack';
    return [player, droneAt({ id: 'AI-training', team: 1, role: attacking ? 'striker' : 'defender',
      ai: true, x: attacking ? 1.3 : 1.5, y: radius, z: attacking ? 0 : .55, yaw: Math.PI })];
  }
  return [player];
}

export function doAction(game, id, action) {
  const drone = game.drones.find(drone => drone.id === id);
  if (!drone || game.paused || game.phase === 'finished' || game.training?.result || game.training?.tipRemaining > 0) return;
  if (action === 'check' && game.phase === 'inspection') {
    game.training.checked = true;
    game.phase = 'countdown';
  }
  if (action === 'arm' && drone.active && !drone.flipped && !drone.recovering) {
    if (game.phase !== 'countdown' && timeValid(game.phase)) {
      drone.armed = !drone.armed;
      emit(game, drone.armed ? 'arm' : 'disarm', { player: id });
    } else if (game.match && game.phase === 'countdown' && !drone.early) {
      drone.early = true;
      foul(game, drone, '提前解鎖起飛');
    }
  }
  if (action === 'stop') {
    drone.armed = false;
    emit(game, 'stop', { player: id });
  }
  if (action === 'turtle' && turtle(drone)) {
    if (game.training) {
      game.training.recovered = true;
      game.training.started = true;
    }
    emit(game, 'turtle', { player: id });
  }
}

function foul(game, drone, reason) {
  const team = 1 - drone.team;
  game.penalties[drone.team]++;
  if (game.penaltyQueue.length < 8) game.penaltyQueue.push(team);
  emit(game, 'foul', { team: drone.team, player: drone.id, reason });
}

function startPenalty(game) {
  const team = game.penaltyQueue.shift();
  const attacker = game.drones.find(drone => drone.team === team && drone.role === 'striker');
  const defender = game.drones.find(drone => drone.team !== team && drone.role === 'defender');
  game.penalty = { team, attacker: attacker.id, defender: defender.id, lasts: 10,
    phase: game.phase, remaining: game.remaining };
  game.phase = 'penalty';
  for (const drone of game.drones) {
    drone.active = drone === attacker || drone === defender;
    if (!drone.active) continue;
    const x = (drone === attacker ? 0.45 : 1.51) * -homeSide(team);
    moveDrone(drone, x, drone === attacker ? 1.7 : 1.95, drone === attacker ? 0 : .42);
  }
  game.attackStart[team] = game.time;
  emit(game, 'penalty', { team });
}

function moveDrone(drone, x, y, z) {
  drone.p = point(x, y, z);
  drone.prev = { ...drone.p };
  drone.v = point();
  drone.crossing = {};
  drone.contacts.clear();
  drone.roll = 0;
  drone.pitch = 0;
  drone.flipped = false;
  drone.recovering = 0;
  drone.yaw = drone.team ? Math.PI : 0;
}

function endPenalty(game) {
  if (!game.penalty) return;
  game.phase = game.penalty.phase;
  game.remaining = game.penalty.remaining;
  game.penalty = null;
  for (const drone of game.drones) drone.active = true;
  emit(game, 'resume');
}

function advanceSet(game) {
  const winner = game.score[0] === game.score[1] ? null : game.score[0] > game.score[1] ? 0 : 1;
  if (winner === null) {
    game.phase = 'golden';
    game.remaining = 0;
    emit(game, 'golden');
    return;
  }
  game.sets.push([...game.score]);
  for (const goal of game.trace.goals) if (goal.set === game.setNumber) goal.setEnded = true;
  game.wins[winner]++;
  if (game.wins[winner] === 2 || game.setNumber === 3) {
    game.phase = 'finished';
    emit(game, 'finished', { team: winner });
  } else {
    game.phase = 'break';
    game.remaining = game.breakSeconds;
    emit(game, 'setEnd', { team: winner });
  }
}

function nextSet(game) {
  game.setNumber++;
  game.score = [0, 0];
  game.blocked = [false, false];
  game.drones = createRoster(game, game.options.roster ?? []);
  game.phase = 'countdown';
  game.remaining = 3;
}

function registerScore(game, drone, goal) {
  if (drone.role !== 'striker' || homeSide(drone.team) === goal.direction) return false;
  if (game.penalty && drone.id !== game.penalty.attacker) return false;
  if (game.match && !game.penalty && game.blocked[drone.team]) {
    if (game.time - (drone.lastReturnFoul ?? -10) > 1) {
      drone.lastReturnFoul = game.time;
      foul(game, drone, '全隊尚未回到己方半場');
    }
    return false;
  }
  if (game.mode !== 'training') game.score[drone.team]++;
  const event = emit(game, 'goal', { team: drone.team, player: drone.id, score: [...game.score] });
  if (game.trace) recordGoal(game.trace, event, drone, goal, game);
  if (game.match) {
    game.blocked[drone.team] = true;
    if (game.penalty) endPenalty(game);
    if (game.phase === 'golden') advanceSet(game);
  }
  return true;
}

function aiControl(game, drone, index) {
  const defending = drone.role === 'defender';
  const sign = homeSide(drone.team);
  const goal = game.goals.find(goal => goal.direction === -sign);
  const gain = { easy: .75, normal: 1.12, hard: 1.55 }[game.difficulty] ?? 1.1;
  if (drone.flipped) {
    turtle(drone);
    return neutral();
  }
  if (!drone.recovering) drone.armed = true;
  let target;
  if (game.penalty && drone.id === game.penalty.defender) {
    target = point(1.56 * sign, 2, Math.sin(game.time * 1.8) * .42);
  } else if (game.mode === 'training' && defending) {
    target = point(1.48 * sign, 2, Math.sin(game.time * 1.2) * .50);
  } else if (!game.penalty && game.blocked[drone.team]) {
    target = point((1.45 + index % 3 * .31) * sign, 1.42 + index % 2 * .52, (index % 5 - 2) * .36);
    if (inHome(drone)) target.x = drone.p.x;
    drone.aiApproach = false;
  } else if (drone.role === 'striker' && goal) {
    if (drone.p.x * -sign < (goal.x * -sign - .25) && Math.abs(drone.p.y - goal.y) < .055 &&
        Math.abs(drone.p.z - goal.z) < .047) drone.aiApproach = true;
    if (drone.p.x * -sign > goal.x * -sign + .42) drone.aiApproach = false;
    target = point(goal.x + (drone.aiApproach ? -.66 : .66) * sign, goal.y, goal.z);
  } else {
    const rival = game.drones.find(other => other.team !== drone.team && other.role === 'striker');
    target = point((defending ? 1.68 : .85 + index % 4 * .23) * sign,
      defending ? 1.85 + .12 * Math.sin(game.time) : 1.20 + index % 3 * .23,
      defending ? clamp(rival?.p.z ?? .28, -.47, .47) + Math.sin(game.time * 1.1) * .22 :
        (index % 2 ? -.82 : .82) + .11 * Math.sin(game.time + index));
  }
  for (const other of game.drones) {
    if (other === drone || !other.active) continue;
    const gap = distance(other.p, drone.p);
    if (gap <= .25 || gap > .43 || other.team !== drone.team) continue;
    target.z += (drone.p.z - other.p.z) / gap * .3;
    target.y += (drone.p.y - other.p.y) / gap * .15;
  }
  return autopilot(drone, target, gain);
}

function observeContacts(game, drone) {
  for (const key of drone.nextContacts) {
    if (drone.contacts.has(key)) continue;
    drone.collisions++;
    emit(game, 'collision', { player: drone.id, obstacle: key, p: Object.values(drone.p) });
  }
  drone.contacts = drone.nextContacts;
}

function updateTrainingStart(game) {
  const run = game.training;
  if (run.started) return;
  const player = game.drones[0];
  if (!player.armed) return;
  const [x, height, z] = run.level.start;
  if (!run.takeoffTarget || (Math.hypot(player.p.x - x, player.p.z - z) <= .38 &&
      Math.abs(player.p.y - height) <= .17)) {
    run.started = true;
  }
}

export function tickGame(game, inputs = {}, dt = STEP) {
  if (game.paused || game.phase === 'finished' || game.training?.result) return;
  if (game.phase === 'inspection') return;
  if (game.phase === 'break' || game.phase === 'countdown') {
    game.remaining = Math.max(0, game.remaining - dt);
    if (game.remaining > 1e-7) return;
    if (game.phase === 'break') {
      nextSet(game);
      return;
    }
    game.phase = 'playing';
    game.remaining = game.match ? game.setSeconds : 0;
    game.attackStart = [game.time, game.time];
    if (game.training?.timedFromWhistle) game.training.started = true;
    emit(game, 'start');
    if (game.penaltyQueue.length) startPenalty(game);
    return;
  }
  const training = game.training;
  if (training?.tipRemaining > 0) {
    training.tipRemaining = Math.max(0, training.tipRemaining - dt);
    const progress = 1 - training.tipRemaining / tipDuration;
    const drone = game.drones[0];
    drone.roll = Math.PI * progress * progress * (3 - 2 * progress);
    drone.flipped = training.tipRemaining === 0;
    return;
  }
  game.time += dt;
  if (game.penalty) game.penalty.lasts -= dt;
  else if (game.match && game.phase === 'playing') game.remaining -= dt;
  const live = game.drones.filter(drone => drone.active);
  if (game.training) updateTrainingStart(game);
  const trainingGoals = [];
  let defended = false;
  const crossings = [];

  for (const [i, drone] of live.entries()) {
    const oldYaw = drone.yaw;
    const wasHome = inHome(drone);
    const input = drone.ai ? (
      !game.training || game.training.started ? aiControl(game, drone, i) : neutral()
    ) : inputs[drone.id] ?? neutral();
    drone.input = input;
    stepDrone(drone, input, dt, { ...game.controls, ...game.seatSettings[drone.id] },
      game.manual && !drone.ai);
    drone.yawDelta = drone.yaw - oldYaw;
    boundDrone(drone, game.field, game.controls.bounce);
    if (game.match && wasHome !== inHome(drone)) emit(game, 'half', { player: drone.id, home: !wasHome });
    for (const goal of game.goals) {
      if (collideGoal(drone, goal, game.controls.bounce)) crossings.push({ drone, goal });
      if (game.match && drone.role !== 'striker' && homeSide(drone.team) === goal.direction && !game.penalty) {
        const inside = Math.abs(drone.p.x - goal.x) < .12 && goalCoordinate(drone.p, goal) < goal.inner;
        if (inside && !drone.inOwnGoal) foul(game, drone, '非法穿越或停留於己方球門');
        drone.inOwnGoal = inside;
      }
    }
  }
  for (const [i, a] of live.entries()) {
    for (const b of live.slice(i + 1)) {
      collideDrones(a, b, game.controls.bounce);
      if (game.training && a.id === game.pilotId && a.nextContacts.has(b.id) &&
          distance(a.p, game.practice.stages[game.training.stage].p) < .47) defended = true;
    }
  }
  for (const drone of live) observeContacts(game, drone);
  if (game.trace) recordFrame(game.trace, game.drones, game.time);

  for (const { drone, goal } of crossings) {
    if (game.phase === 'break' || game.phase === 'finished') break;
    if (game.training) {
      if (game.training.started && drone.id === game.pilotId) {
        trainingGoals.push(goal.id);
        emit(game, 'goal', { team: drone.team, player: drone.id });
      }
    } else registerScore(game, drone, goal);
  }

  if (game.training) {
    const run = game.training;
    if (run.started || run.level.stages[run.stage].type === 'check') {
      evaluateTraining(run, game.drones[0], trainingGoals, dt, defended);
    }
    return;
  }
  if (!game.match || !timeValid(game.phase)) return;
  if (game.penalty && game.penalty.lasts <= 0) endPenalty(game);
  if (!game.penalty) {
    for (const team of [0, 1]) {
      const airborne = game.drones.filter(drone => drone.team === team && drone.active && drone.p.y > radius + .02);
      if (game.blocked[team] && airborne.every(inHome)) {
        game.blocked[team] = false;
        game.attackStart[team] = game.time;
        const goal = game.trace.goals.findLast(goal => goal.team === team && goal.returned == null);
        if (goal) goal.returned = game.time - goal.t;
        emit(game, 'return', { team });
      }
    }
    if (game.penaltyQueue.length) startPenalty(game);
    else if (game.phase === 'playing' && game.remaining <= 1e-7) advanceSet(game);
  }
}

export function snapshot(game) {
  return {
    id: game.id, mode: game.mode, profileId: game.profileId, field: game.field, goals: game.goals,
    phase: game.phase, time: game.time, remaining: game.penalty?.lasts ?? game.remaining,
    setNumber: game.setNumber, score: game.score, blocked: game.blocked, wins: game.wins, sets: game.sets,
    penalties: game.penalties, penalty: game.penalty, events: game.events.slice(-20),
    drones: game.drones.map(({ id, team, role, ai, p, v, yaw, pitch, roll, armed, flipped, recovering,
      active, collisions, input }) =>
      ({ id, team, role, ai, p, v, yaw, pitch, roll, armed, flipped, recovering, active, collisions, input })),
    traceGoals: game.trace?.goals.map(({ highlight, ...summary }) => summary),
  };
}
