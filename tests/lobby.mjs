/**
 * בדיקת הלובי והסנכרון בין מכשירים.
 *
 * ערוץ החדר האמיתי קיים רק בתוך claude.ai, ולכן כאן מוזרק חדר מדומה
 * שמבוסס על BroadcastChannel: שני דפים באותו מקור מדברים זה עם זה בדיוק
 * כמו שני מכשירים. זו הבדיקה היחידה שמאמתת את ההצמדה עצמה — שהמקרן
 * באמת עוקב אחרי המנחה.
 *
 * הרצה:  node tests/lobby.mjs
 */
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require_ = createRequire(import.meta.url);
function loadPlaywright(){
  try { return require_('playwright'); } catch {}
  const g = execSync('npm root -g', { encoding:'utf8' }).trim();
  return createRequire(path.join(g, 'x.js'))('playwright');
}
const { chromium } = loadPlaywright();

const root  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || path.join(root, '.screenshots');
const PORT  = 8791;
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const problems = [];
const ok   = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = m => { failures++; problems.push(m); console.log('  \x1b[31m✗\x1b[0m ' + m); };

/* חדר מדומה: אותו חוזה שהדף מצפה לו, מעל BroadcastChannel */
const FAKE_ROOM = `(() => {
  const me = 'p' + Math.random().toString(36).slice(2, 10);
  const peers = new Map([[me, { presence: {}, updatedAt: Date.now() }]]);
  const listeners = new Set();
  const bc = new BroadcastChannel('chase-test-room');
  const snapshot = () => [...peers.entries()].map(([peer, v]) => ({
    peer, by: null, isMe: peer === me, sameTab: peer === me, kind: 'viewer',
    presence: Object.freeze({ ...v.presence }), updatedAt: v.updatedAt
  }));
  const fire = () => {
    const list = snapshot();
    listeners.forEach(fn => { try { fn({ peers: list, joined: [], left: [], updated: [] }); } catch(e){} });
  };
  bc.onmessage = e => {
    const m = e.data || {};
    if (m.peer === me) return;
    if (m.type === 'hello'){
      peers.set(m.peer, { presence: m.presence || {}, updatedAt: Date.now() });
      bc.postMessage({ type:'presence', peer: me, presence: peers.get(me).presence });
      fire();
    } else if (m.type === 'presence'){
      peers.set(m.peer, { presence: m.presence || {}, updatedAt: Date.now() });
      fire();
    } else if (m.type === 'bye'){ peers.delete(m.peer); fire(); }
  };
  addEventListener('pagehide', () => { try { bc.postMessage({ type:'bye', peer: me }); } catch(e){} });
  const room = {
    presence(patch){
      const next = { ...peers.get(me).presence };
      Object.keys(patch || {}).forEach(k => { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; });
      peers.set(me, { presence: next, updatedAt: Date.now() });
      bc.postMessage({ type:'presence', peer: me, presence: next });
      fire();
      return Promise.resolve();
    },
    peers: snapshot,
    onPeers(fn){ listeners.add(fn); queueMicrotask(fire); return () => listeners.delete(fn); },
    emit(){ return Promise.resolve(); },
    on(){ return () => {}; },
    connected(){ return true; },
    onConnection(fn){ queueMicrotask(() => fn(true)); return () => {}; }
  };
  bc.postMessage({ type:'hello', peer: me, presence: {} });
  window.claude = { use: async n => (n === 'room' ? room : null) };
})();`;

const url = `http://localhost:${PORT}/index.html?fast=1`;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch(e){} };
process.on('exit', stop);
await new Promise(r => setTimeout(r, 900));

console.log('בדיקת לובי וסנכרון בין מכשירים\nכתובת: ' + url);
console.log('\n▶ שני מכשירים באותו חדר');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{ width:1100, height:820 }, locale:'he-IL' });
await ctx.addInitScript(FAKE_ROOM);
const errors = [];

/** מביא מכשיר עד הלובי בתפקיד מבוקש */
async function joinAs(page, dev){
  page.on('pageerror', e => errors.push(dev + ': ' + e.message));
  await page.goto(url, { waitUntil:'domcontentloaded' });
  await page.waitForSelector(`[data-dev="${dev}"]`, { state:'visible', timeout: 15000 });
  await page.click(`[data-dev="${dev}"]`);
  await page.click('#f-next');
}

const host = await ctx.newPage();
await joinAs(host, 'host');
await host.waitForSelector('#lb-list .lrow');
ok('המנחה נכנס ללובי');

const screen = await ctx.newPage();
await joinAs(screen, 'screen');
await screen.waitForSelector('#lb-list .lrow');
ok('מסך ההקרנה נכנס ללובי');

// שני המכשירים רואים זה את זה
await host.waitForTimeout(700);
const seen = await host.evaluate(() =>
  [...document.querySelectorAll('#lb-list .lrow.on')].map(r => r.querySelector('b').textContent.trim()));
(seen.includes('מסך מנחה') && seen.includes('מסך הקרנה'))
  ? ok(`המנחה רואה את שני התפקידים (${seen.join(', ')})`)
  : fail('הלובי אצל המנחה מראה: ' + JSON.stringify(seen));

const seenB = await screen.evaluate(() =>
  [...document.querySelectorAll('#lb-list .lrow.on')].map(r => r.querySelector('b').textContent.trim()));
seenB.length === 2 ? ok('גם מסך ההקרנה רואה את שניהם')
                   : fail('הלובי אצל ההקרנה מראה: ' + JSON.stringify(seenB));
await host.screenshot({ path: path.join(SHOTS, 'lobby-host.png') });

// צ׳ייסר מצטרף באיחור ומופיע מיד אצל כולם
const chaser = await ctx.newPage();
await joinAs(chaser, 'chaser');
await host.waitForTimeout(700);
const withChaser = await host.evaluate(() => document.querySelectorAll('#lb-list .lrow.on').length);
withChaser === 3 ? ok('צ׳ייסר שמצטרף באיחור מופיע מיד אצל המנחה')
                 : fail('אחרי הצטרפות הצ׳ייסר נראים ' + withChaser + ' תפקידים');

// המנחה מתחיל משחק — האחרים עוברים בלי שאיש נגע בהם
await host.click('#lb-go');
await host.waitForSelector('[data-count="1"]');
await host.click('[data-count="1"]');
await host.click('#f-next');
await host.waitForSelector('[data-lvl="medium"]');
await host.click('#f-next');
await host.waitForSelector('[data-cat]');
await host.click('#f-next');
await host.waitForFunction(() => window.__chase.state.screen === 'ready', null, { timeout: 15000 });
await host.click('#go');
await host.waitForFunction(() => window.__chase.state.screen === 'cash', null, { timeout: 15000 });

await screen.waitForFunction(() => window.__chase.state.screen === 'projector', null, { timeout: 15000 })
  .then(() => ok('מסך ההקרנה עבר למצב הקרנה מעצמו'))
  .catch(() => fail('מסך ההקרנה לא עבר כשהמשחק התחיל'));

// והמסך הגדול באמת מציג את השאלה של המנחה
await screen.waitForTimeout(900);
const mirrored = await screen.evaluate(() => {
  const q = document.querySelector('#proj .proj-q');
  return q ? q.textContent.trim() : null;
});
const hostQ = await host.evaluate(() => window.__chase.state.cash.q.q);
(mirrored && mirrored === hostQ)
  ? ok(`השאלה של המנחה מוצגת בהקרנה ("${mirrored.slice(0, 32)}…")`)
  : fail('ההקרנה לא שיקפה את השאלה. הקרנה=' + JSON.stringify(mirrored));

// והתשובה עדיין לא שם
const answer = await host.evaluate(() => window.__chase.state.cash.q.a);
const leak = await screen.evaluate(() => document.body.innerText);
!leak.includes(answer) ? ok('התשובה לא הופיעה על המסך הגדול')
                       : fail('התשובה דלפה להקרנה: ' + answer);
await screen.screenshot({ path: path.join(SHOTS, 'lobby-projector.png') });

errors.length ? fail('שגיאות: ' + errors.slice(0, 3).join(' | ')) : ok('אין שגיאות');

await browser.close();
stop();

console.log('\nצילומי מסך: ' + SHOTS);
if (failures){
  console.log(`\n\x1b[31m${failures} בדיקות נכשלו\x1b[0m`);
  problems.forEach(p => console.log(' - ' + p));
  process.exit(1);
}
console.log('\n\x1b[32mכל הבדיקות עברו\x1b[0m');
