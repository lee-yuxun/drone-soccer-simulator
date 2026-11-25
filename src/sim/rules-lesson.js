import { $, button } from './browser.js';

const chapters = [
  { name: '聽哨起飛', title: '等哨音再起飛',
    copy: '倒數期間無人機留在地面。哨音響後才解鎖、推油門。',
    poses: [[0, 125, 188], [.50, 125, 188], [.86, 210, 108]],
    caption: t => t < .48 ? '倒數 ' + Math.max(1, Math.ceil(3 - t / .16)) : '哨音響起 · 可以起飛',
    prompt: '倒數還剩一秒，可以先解鎖嗎？', choices: ['可以，先起飛比較快', '等哨音響起'], correct: 1,
    feedback: '提前解鎖可能讓對手獲得罰球。', level: 25, practice: '練習聽哨與起飛' },
  { name: '正面得分', title: '得分手整顆飛過球門',
    copy: '從中線這一側接近對方球門，從正面朝底線飛，整顆護籠通過才計 1 分。',
    poses: [[0, 278, 111], [.28, 430, 102], [.68, 520, 102], [.88, 570, 102]],
    caption: t => t >= .68 ? '＋1 分 · 護籠已完全通過' : '得分手由場內向對手底線飛',
    prompt: '護籠還有一半留在球門前，得分了嗎？', choices: ['等整顆護籠通過', '已經得分'], correct: 0,
    feedback: '必須完整由正面通過，擦框或未完全穿越都不算分。', level: 9, practice: '練習正面穿門' },
  { name: '背面不計分', title: '通過方向也要對',
    copy: '得分手從底線端往中場反穿同一個門，比分維持原樣。支援或防守隊員穿過對手球門也不計分。',
    poses: [[0, 568, 102], [.28, 548, 102], [.68, 420, 102], [.90, 338, 102]],
    caption: t => t >= .68 ? '0 分 · 從背面反穿' : '飛行方向朝中場',
    prompt: '得分手從對方底線往中線穿門，裁判會怎麼判？', choices: ['不加分', '加 1 分'], correct: 0,
    feedback: '必須朝對手底線飛越球門，反向穿越不能得分。', level: 9, practice: '自己試一次正面穿門' },
  { name: '得分後回防', title: '得分隊全員先回半場',
    copy: '得分後，紅隊所有仍在空中的隊員要回到中線左側，才能再次進攻。',
    poses: [[0, 545, 103], [.26, 467, 105], [.76, 238, 113], [.92, 217, 113]],
    wingmen: [[[0, 398, 137], [.62, 204, 145]], [[0, 407, 167], [.92, 243, 165]]],
    caption: t => t >= .78 ? '全隊已回半場 · 進攻再開放' : '紅隊正在回半場 · 先不要射門',
    prompt: '只有得分手回到己方半場，隊友還在對方半場，可以再射門嗎？', choices: ['等空中的隊友都回來', '可以立刻再射門'], correct: 0,
    feedback: '所有仍在空中的得分隊隊員都要回到己方半場。', level: 22, practice: '練習進球後回防' },
  { name: '10 秒罰球', duration: 10000, title: '得分手對一名防守員',
    copy: '進入罰球後，Set 的時間暫停。哨音後，得分手有 10 秒完成射門。',
    poses: [[0, 245, 156], [.3, 330, 100], [.72, 485, 102], [.92, 557, 102]],
    defender: [[0, 450, 142], [.32, 427, 145], [.73, 468, 145]],
    caption: t => (t > .86 ? '示範完成' : '罰球剩 ' + Math.max(1, Math.ceil(10 - t * 10)) + ' 秒') + ' · Set 計時暫停',
    prompt: '罰球的 10 秒會扣掉本局剩餘時間嗎？', choices: ['會扣時間', '本局計時暫停'], correct: 1,
    feedback: '罰球有獨立的 10 秒計時，本局時間不變。', level: 25, practice: '試玩 10 秒罰球' },
];

function positionAt(keyframes, t) {
  const end = keyframes.findIndex(([time]) => time > t);
  if (end < 1) return keyframes[end === 0 ? 0 : keyframes.length - 1].slice(1);
  const [from, x, y] = keyframes[end - 1];
  const [to, x2, y2] = keyframes[end];
  const progress = (t - from) / (to - from);
  return [x + (x2 - x) * progress, y + (y2 - y) * progress];
}

export function mountRulesLesson(startPractice) {
  const dialog = $('rules-dialog');
  const canvas = $('rules-demo');
  const ctx = canvas.getContext('2d');
  const timeline = $('rules-timeline');
  const play = $('rules-play');
  const chaptersHost = $('rules-chapters');
  let selected = 0;
  let progress = 0;
  let frame = 0;
  let playing = false;
  let previous = 0;

  function drone(points, time, color, striker = false) {
    const [x, y] = positionAt(points, time);
    ctx.beginPath();
    ctx.arc(x, y, striker ? 12 : 9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = striker ? 3 : 1;
    ctx.strokeStyle = striker ? '#fce7a8' : '#f1faff';
    ctx.stroke();
    if (striker) {
      ctx.fillStyle = '#132037';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw() {
    const chapter = chapters[selected];
    timeline.value = Math.round(progress * 100);
    const caption = chapter.caption(progress);
    if ($('rules-demo-caption').textContent !== caption) $('rules-demo-caption').textContent = caption;
    if (!ctx) return;
    ctx.fillStyle = '#101d32';
    ctx.fillRect(0, 0, 640, 228);
    ctx.fillStyle = '#282133';
    ctx.fillRect(36, 38, 284, 159);
    ctx.fillStyle = '#172e4a';
    ctx.fillRect(320, 38, 284, 159);
    ctx.strokeStyle = '#7487a4';
    ctx.lineWidth = 2;
    ctx.strokeRect(36, 38, 568, 159);
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.moveTo(320, 39);
    ctx.lineTo(320, 196);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillStyle = '#f9aab1';
    ctx.fillText('紅隊半場', 48, 27);
    ctx.fillStyle = '#a8d1ff';
    ctx.fillText('藍隊半場', 535, 27);
    ctx.fillStyle = '#c8d5e7';
    ctx.fillText('中線', 305, 216);
    for (const [x, color] of [[142, '#ef717e'], [488, '#62acff']]) {
      ctx.beginPath();
      ctx.ellipse(x, 102, 12, 31, 0, 0, Math.PI * 2);
      ctx.lineWidth = 6;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    chapter.poses.forEach(([, x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f8c8d688';
    ctx.stroke();
    ctx.setLineDash([]);
    for (const poses of chapter.wingmen ?? []) drone(poses, progress, '#f28697');
    if (chapter.defender) drone(chapter.defender, progress, '#70b6ff');
    drone(chapter.poses, progress, '#f47b8a', true);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(frame);
    play.textContent = progress >= 1 ? '重播' : '播放';
  }
  function advance(now) {
    if (!playing || !dialog.open) { stop(); return; }
    if (previous) progress = Math.min(1, progress + (now - previous) / (chapters[selected].duration ?? 5600));
    previous = now;
    draw();
    if (progress >= 1) stop();
    else frame = requestAnimationFrame(advance);
  }
  function select(index) {
    selected = index;
    progress = 0;
    stop();
    const chapter = chapters[index];
    for (const [i, tab] of [...chaptersHost.children].entries()) tab.setAttribute('aria-pressed', String(i === selected));
    $('rules-demo-title').textContent = chapter.title;
    $('rules-demo-copy').textContent = chapter.copy;
    $('rules-question').textContent = chapter.prompt;
    $('rules-practice').textContent = chapter.practice;
    $('rules-feedback').textContent = '';
    const options = chapter.choices.map((text, i) => button(text, () => {
      const correct = i === chapter.correct;
      for (const [j, answer] of options.entries()) answer.setAttribute('aria-pressed', String(j === i));
      $('rules-feedback').textContent = (correct ? '答對了。' : '再想一下。') + chapter.feedback;
      $('rules-feedback').dataset.correct = String(correct);
    }, { 'aria-pressed': 'false' }));
    $('rules-answers').replaceChildren(...options);
    draw();
  }

  for (const [index, chapter] of chapters.entries()) {
    chaptersHost.append(button(chapter.name, () => select(index), { 'aria-pressed': 'false' }));
  }
  play.onclick = () => {
    if (playing) { stop(); return; }
    if (progress >= 1) progress = 0;
    playing = true;
    previous = 0;
    play.textContent = '暫停';
    frame = requestAnimationFrame(advance);
  };
  timeline.oninput = () => { progress = Number(timeline.value) / 100; stop(); draw(); };
  $('rules-practice').onclick = () => startPractice(chapters[selected].level);
  dialog.addEventListener('close', stop);
  select(0);
}
