'use strict';
/* ========== ユーティリティ / 永続化 ========== */
const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};
const pad = n => String(n).padStart(2, '0');
const dateKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeStr = (ms, sec) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` + (sec ? `:${pad(d.getSeconds())}` : ''); };
const goldOf = n => Math.floor(n / 4);          // 1日あたり4ポモドーロごとに金1つ

/* 実績: 完了時刻(ms)の配列。金は日ごとの件数から導出 */
let sessions = LS.get('pomo.sessions', []);
let settings = Object.assign({ work: 25, break: 5, sound: false, autoBreak: false, autoWork: false }, LS.get('pomo.settings', {}));   // sound: アラーム音 / autoBreak: 作業後に休憩を自動開始 / autoWork: 休憩後に作業を自動開始（既定はいずれもOFF）
let timer = LS.get('pomo.timer', null) || { phase: 'work', status: 'idle', endAt: 0, remaining: settings.work * 60000 };

const saveSessions = () => LS.set('pomo.sessions', sessions);
const saveTimer = () => LS.set('pomo.timer', timer);

function byDay() {
  const m = new Map();
  [...sessions].sort((a, b) => a - b).forEach(t => {
    const k = dateKey(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  });
  return m;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ========== タイマー ========== */
const durOf = ph => (ph === 'work' ? settings.work : settings.break) * 60000;
const CIRC = 2 * Math.PI * 100;

function startTimer() {
  if (timer.status === 'running') {            // 一時停止
    timer.remaining = Math.max(0, timer.endAt - Date.now());
    timer.status = 'paused';
  } else {                                      // 開始 / 再開
    timer.endAt = Date.now() + timer.remaining;  // 差分計算の基準となる終了時刻
    timer.status = 'running';
    requestNotif();
    unlockAudio();
  }
  saveTimer(); render();
}

function resetTimer() {
  timer.status = 'idle'; timer.remaining = durOf(timer.phase); saveTimer(); render();
}

function skipPhase() {
  timer.phase = timer.phase === 'work' ? 'break' : 'work';
  resetTimer();
}

/* 終了処理。at = 本来の終了時刻（スリープ中に終わっても正しい記録時刻になる） */
function complete(at) {
  const wasWork = timer.phase === 'work';
  if (Date.now() - at < 10000) playChime();   // 復帰時の大幅な遅延では鳴らさない
  if (wasWork) {
    sessions.push(at); saveSessions();
    const n = (byDay().get(dateKey(at)) || []).length;
    const gold = n % 4 === 0;
    notify(gold ? '🥇 金のポモドーロ獲得！' : '🍅 作業おつかれさま', gold ? `本日${n}ポモドーロ達成。休憩しましょう。` : `本日${n}ポモドーロ。休憩しましょう。`);
  } else {
    notify('休憩終了', '次の作業を始めましょう。');
  }
  timer.phase = wasWork ? 'break' : 'work';
  timer.status = 'idle'; timer.remaining = durOf(timer.phase);
  // 自動開始（本来の終了時刻から計測するのでずれない。次のフェーズも既に終わっている場合は開始しない＝離席中に連鎖記録されない）
  if ((wasWork ? settings.autoBreak : settings.autoWork) && at + durOf(timer.phase) > Date.now()) {
    timer.status = 'running'; timer.endAt = at + durOf(timer.phase);
  }
  saveTimer(); render(); renderCalendar(); renderShare();
}

function tick() {
  if (timer.status === 'running') {
    const left = timer.endAt - Date.now();
    if (left <= 0) { complete(timer.endAt); return; }
    paint(left);
  } else paint(timer.remaining);
}

function paint(ms) {
  const sec = Math.ceil(ms / 1000);
  const txt = `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
  $('#timeText').textContent = txt;
  $('#ringFg').style.strokeDashoffset = CIRC * (1 - ms / durOf(timer.phase));
  document.title = timer.status === 'running' ? `${txt} – Pomodoro` : 'Pomodoro – シンプルなポモドーロタイマー';
}

function render() {
  document.body.classList.toggle('is-break', timer.phase === 'break');
  $('#phaseLabel').textContent = timer.phase === 'work' ? '作業' : '休憩';
  $('#btnStart').textContent = timer.status === 'running' ? '一時停止' : (timer.status === 'paused' ? '再開' : '開始');
  const days = byDay(), n = (days.get(dateKey(Date.now())) || []).length;
  $('#todayCount').textContent = `🍅 ${n}`;
  $('#todayGold').textContent = `🥇 ${goldOf(n)}`;
  $('#progress4').innerHTML = [0, 1, 2, 3].map(i => `<span class="dot ${i < n % 4 ? 'on' : ''}"></span>`).join('');
  $('#setWork').value = settings.work; $('#setBreak').value = settings.break;
  $('#setSound').checked = settings.sound;
  $('#setAutoBreak').checked = settings.autoBreak;
  $('#setAutoWork').checked = settings.autoWork;
  paint(timer.status === 'running' ? Math.max(0, timer.endAt - Date.now()) : timer.remaining);
}

/* ========== アラーム音（任意・Web Audioで合成。音声ファイル不要） ========== */
let audioCtx = null;
function unlockAudio() {   // iOSはユーザー操作内で生成/再開が必要
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { }
}
function playChime() {
  if (!settings.sound) return;
  try {
    unlockAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + 0.05;
    [880, 1174.66, 1567.98].forEach((f, i) => {   // 上昇する3音
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = t0 + i * 0.22;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.65);
    });
  } catch { }
}

/* ========== 通知（サイレント） ========== */
function requestNotif() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission().then(updateHint);
}
function updateHint() {
  let m = '';
  if (!('Notification' in window)) m = 'この環境は通知に未対応です。iPhoneはホーム画面に追加すると通知が使えます。';
  else if (Notification.permission === 'denied') m = '通知がブロックされています。ブラウザ設定で許可してください。';
  else if (Notification.permission === 'default') m = '開始ボタンを押すと通知の許可を求めます（通知自体はサイレントです）。';
  $('#notifHint').textContent = m;
}
async function notify(title, body) {
  if (navigator.vibrate) { /* 振動も行わない（職場配慮） */ }
  if (!('Notification' in window) || Notification.permission !== 'granted') { toast(title); return; }
  const opt = { body, silent: true, tag: 'pomodoro', renotify: false, icon: 'icons/icon-512.png', badge: 'icons/icon.svg' };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) return reg.showNotification(title, opt);   // iOS PWA ではSW経由が必要
    new Notification(title, opt);
  } catch { try { new Notification(title, opt); } catch { toast(title); } }
}

/* ========== カレンダー ========== */
let view = new Date(); view.setDate(1);
let selected = dateKey(Date.now());

function renderCalendar() {
  const y = view.getFullYear(), m = view.getMonth(), days = byDay();
  $('#calTitle').textContent = `${y}年${m + 1}月`;
  const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate();
  let h = '日月火水木金土'.split('').map(w => `<div class="cal-dow">${w}</div>`).join('');
  for (let i = 0; i < first; i++) h += '<div class="cell empty"></div>';
  let tp = 0, tg = 0;
  for (let d = 1; d <= last; d++) {
    const k = `${y}-${pad(m + 1)}-${pad(d)}`, n = (days.get(k) || []).length, g = goldOf(n);
    tp += n; tg += g;
    h += `<button class="cell ${n ? 'has' : ''} ${k === dateKey(Date.now()) ? 'today' : ''} ${k === selected ? 'sel' : ''}" data-k="${k}">
      <span class="d">${d}</span><span class="n">${n ? '🍅' + n : ''}</span><span class="g">${g ? '🥇' + g : ''}</span></button>`;
  }
  $('#calGrid').innerHTML = h;
  $('#calSum').textContent = `この月: 🍅 ${tp}  /  🥇 ${tg}`;
  renderDetail();
}

function renderDetail() {
  const list = byDay().get(selected) || [];
  const [y, m, d] = selected.split('-').map(Number);
  $('#dayDetail').innerHTML = `<b>${m}月${d}日</b>　🍅 ${list.length} / 🥇 ${goldOf(list.length)}` +
    (list.length ? `<ul>${list.map((t, i) => `<li>${timeStr(t)} 完了${(i + 1) % 4 === 0 ? ' 🥇' : ''}</li>`).join('')}</ul>` : '<br>この日の記録はありません。');
}

/* ========== 共有 ========== */
function shareTextOf() {
  const list = byDay().get(dateKey(Date.now())) || [], n = list.length, g = goldOf(n);
  const d = new Date();
  const last = n ? `\n最終完了 ${timeStr(list[n - 1])}` : '';
  return `🍅 ${d.getMonth() + 1}/${d.getDate()} の作業記録\nポモドーロ ${n}回（${n * settings.work}分集中）\n金のポモドーロ 🥇×${g}${last}\n#ポモドーロ #作業記録`;
}
const renderShare = () => { $('#shareText').value = shareTextOf(); };

async function copyText() {
  const t = $('#shareText').value;
  try { await navigator.clipboard.writeText(t); }
  catch { $('#shareText').select(); document.execCommand('copy'); }
  toast('コピーしました');
}

/* ライブラリ不要: Canvasで直接描画（オフラインでも確実に動作） */
function drawCalendarCanvas() {
  const y = view.getFullYear(), m = view.getMonth(), days = byDay();
  const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate();
  const rows = Math.ceil((first + last) / 7), W = 1080, cw = 140, ch = 128, gx = 50;
  const H = 300 + rows * (ch + 8) + 140;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const font = '-apple-system,"Hiragino Sans","Yu Gothic UI","Segoe UI",sans-serif';
  x.fillStyle = '#fafaf9'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#1c1917'; x.font = `700 56px ${font}`; x.textAlign = 'left'; x.fillText(`🍅 ${y}年${m + 1}月`, gx, 100);
  let tp = 0, tg = 0;
  for (let d = 1; d <= last; d++) { const n = (days.get(`${y}-${pad(m + 1)}-${pad(d)}`) || []).length; tp += n; tg += goldOf(n); }
  x.fillStyle = '#78716c'; x.font = `500 34px ${font}`;
  x.fillText(`ポモドーロ ${tp}回   金 ${tg}個`, gx, 160);
  x.textAlign = 'center'; x.font = `500 26px ${font}`;
  '日月火水木金土'.split('').forEach((w, i) => x.fillText(w, gx + i * (cw + 0) + cw / 2 - 4, 250));
  const rr = (px, py, w, h, r) => { x.beginPath(); x.roundRect ? x.roundRect(px, py, w, h, r) : x.rect(px, py, w, h); };
  for (let d = 1; d <= last; d++) {
    const idx = first + d - 1, col = idx % 7, row = Math.floor(idx / 7);
    const px = gx + col * cw, py = 270 + row * (ch + 8), n = (days.get(`${y}-${pad(m + 1)}-${pad(d)}`) || []).length;
    rr(px + 4, py, cw - 8, ch, 16);
    x.fillStyle = n ? '#fdecec' : '#ffffff'; x.fill(); x.strokeStyle = n ? '#f6c9ca' : '#e7e5e4'; x.lineWidth = 2; x.stroke();
    x.textAlign = 'left'; x.fillStyle = '#78716c'; x.font = `500 24px ${font}`; x.fillText(d, px + 18, py + 34);
    x.textAlign = 'center';
    if (n) { x.fillStyle = '#e5484d'; x.font = `700 30px ${font}`; x.fillText(`🍅${n}`, px + cw / 2, py + 78); }
    if (goldOf(n)) { x.fillStyle = '#d4a017'; x.font = `700 28px ${font}`; x.fillText(`🥇${goldOf(n)}`, px + cw / 2, py + 114); }
  }
  x.fillStyle = '#a8a29e'; x.font = `500 26px ${font}`; x.textAlign = 'right';
  x.fillText('Pomodoro', W - gx, H - 50);
  return c;
}

async function saveImage() {
  const c = drawCalendarCanvas();
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const name = `pomodoro-${view.getFullYear()}-${pad(view.getMonth() + 1)}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {   // スマホ: 共有シート
    try { await navigator.share({ files: [file], text: shareTextOf() }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name); toast('画像を保存しました');
}

function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ========== CSV ========== */
function exportCsv() {
  const rows = ['date,time,pomodoro_no,gold'];
  byDay().forEach((list, k) => list.forEach((t, i) => rows.push(`${k},${timeStr(t, true)},${i + 1},${(i + 1) % 4 === 0 ? 1 : 0}`)));
  const blob = new Blob(['\uFEFF' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });   // BOM付きUTF-8
  download(blob, `pomodoro-${dateKey(Date.now())}.csv`); toast('CSVを出力しました');
}

async function importCsv(file) {
  let text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const incoming = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [dt, tm] = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dt || ''), tmm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(tm || '');
    if (!dm || !tmm) continue;                                              // ヘッダ/不正行は無視
    const ts = new Date(+dm[1], +dm[2] - 1, +dm[3], +tmm[1], +tmm[2], +(tmm[3] || 0)).getTime();
    if (!incoming.has(dt)) incoming.set(dt, []);
    incoming.get(dt).push(ts);
  }
  if (!incoming.size) { toast('有効なデータがありません'); return; }
  const today = dateKey(Date.now()), local = byDay();
  let added = 0, overwritten = 0, kept = 0;
  const next = new Map(local);
  incoming.forEach((list, k) => {
    if (!local.has(k)) { next.set(k, list); added++; }                      // 衝突なし → 追加
    else if (k === today) kept++;                                           // 本日: 自端末優先
    else { next.set(k, list); overwritten++; }                              // 昨日以前: CSV優先
  });
  sessions = [...next.values()].flat(); saveSessions();
  render(); renderCalendar(); renderShare();
  toast(`追加${added}日 / 上書き${overwritten}日 / 本日保持${kept}日`);
}

/* ========== イベント ========== */
$('#btnStart').onclick = startTimer;
$('#btnReset').onclick = resetTimer;
$('#btnSkip').onclick = skipPhase;
$('#btnCopy').onclick = copyText;
$('#btnImage').onclick = saveImage;
$('#btnExport').onclick = exportCsv;
$('#btnImport').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => { const f = e.target.files[0]; if (f) importCsv(f); e.target.value = ''; };
$('#calPrev').onclick = () => { view.setMonth(view.getMonth() - 1); renderCalendar(); };
$('#calNext').onclick = () => { view.setMonth(view.getMonth() + 1); renderCalendar(); };
$('#calGrid').onclick = e => { const b = e.target.closest('.cell[data-k]'); if (b) { selected = b.dataset.k; renderCalendar(); } };

function onSetting() {
  const w = Math.min(180, Math.max(1, parseInt($('#setWork').value) || settings.work));
  const b = Math.min(60, Math.max(1, parseInt($('#setBreak').value) || settings.break));
  const wasSound = settings.sound;
  settings = { work: w, break: b, sound: $('#setSound').checked, autoBreak: $('#setAutoBreak').checked, autoWork: $('#setAutoWork').checked }; LS.set('pomo.settings', settings);
  if (settings.sound && !wasSound) { unlockAudio(); playChime(); }   // ONにした時に試聴
  if (timer.status === 'idle') timer.remaining = durOf(timer.phase);
  saveTimer(); render();
}
$('#setWork').onchange = $('#setBreak').onchange = $('#setSound').onchange = $('#setAutoBreak').onchange = $('#setAutoWork').onchange = onSetting;

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + t.dataset.view));
  if (t.dataset.view === 'calendar') renderCalendar();
  if (t.dataset.view === 'data') renderShare();
});

/* バックグラウンドから復帰した瞬間に即再計算 */
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); render(); } });
window.addEventListener('focus', tick);

/* ========== 起動 ========== */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render(); renderCalendar(); renderShare(); updateHint();
tick(); setInterval(tick, 250);
