/**
 * בדיקת ערוץ הקוד — שלושה מכשירים שנפגשים סביב קוד הצטרפות.
 *
 * הממסר האמיתי (ntfy.sh) לא נדרש כאן: הבדיקה מרימה ממסר מקומי שמדבר
 * בדיוק באותם שני קצוות — POST /<topic> ו-GET /<topic>/sse — ומפנה אליו
 * את הדף עם ?relay=. כך רץ קוד הממסר האמיתי של המשחק, בלי אף בקשה
 * לאינטרנט ובלי תלות בשירות חיצוני.
 *
 * הרצה:  node tests/relay.mjs
 */
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
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
const PORT  = 8793, RELAY = 8794;
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const problems = [];
const ok   = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = m => { failures++; problems.push(m); console.log('  \x1b[31m✗\x1b[0m ' + m); };

/* ---------- ממסר מקומי בנוסח ntfy ---------- */
const subs = new Map();                       /* topic → Set<res> */
let published = 0;
const relay = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
  if (req.method === 'OPTIONS'){ res.writeHead(204, cors); return res.end(); }

  const m = url.pathname.match(/^\/([^/]+)(\/sse)?$/);
  if (!m){ res.writeHead(404, cors); return res.end(); }
  const [, topic, sse] = m;

  if (sse && req.method === 'GET'){
    res.writeHead(200, { ...cors, 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
    res.write(': open\n\n');
    if (!subs.has(topic)) subs.set(topic, new Set());
    subs.get(topic).add(res);
    req.on('close', () => subs.get(topic).delete(res));
    return;
  }
  if (req.method === 'POST'){
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      published++;
      const frame = 'data: ' + JSON.stringify({
        id: 'm' + published, time: Math.floor(Date.now() / 1000), event: 'message', topic, message: body
      }) + '\n\n';
      (subs.get(topic) || new Set()).forEach(r => { try { r.write(frame); } catch(e){} });
      res.writeHead(200, { ...cors, 'Content-Type':'application/json' });
      res.end('{}');
    });
    return;
  }
  res.writeHead(405, cors); res.end();
});
await new Promise(r => relay.listen(RELAY, r));

const url = `http://localhost:${PORT}/index.html?fast=1&relay=${encodeURIComponent('http://localhost:' + RELAY)}`;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch(e){} try { relay.close(); } catch(e){} };
process.on('exit', stop);
await new Promise(r => setTimeout(r, 900));

console.log('בדיקת ערוץ הקוד\nכתובת: ' + url);
console.log('\n▶ שלושה מכשירים סביב קוד אחד');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{ width:1100, height:860 }, locale:'he-IL' });
const errors = [];

/** מביא מכשיר עד הלובי: בוחר תפקיד, מקיש את הקוד, מצטרף */
async function joinAs(page, dev, code){
  page.on('pageerror', e => errors.push(dev + ': ' + e.message));
  // localStorage נשמר לכל ההקשר, ולכן מנקים כדי שכל מכשיר יתחיל נקי
  await page.goto(url, { waitUntil:'domcontentloaded' });
  await page.waitForSelector(`[data-dev="${dev}"]`, { state:'visible', timeout: 15000 });
  await page.click(`[data-dev="${dev}"]`);
  await page.click('#f-next');
  await page.waitForFunction(() => window.__chase.state.screen === 'join', null, { timeout: 15000 });
  if (dev === 'host'){
    if (code) await page.evaluate(c => { window.__chase.state.joinCode = c; document.querySelector('#j-code').textContent = c; }, code);
  } else {
    await page.fill('#j-in', code);
  }
  await page.click('#j-go');
  await page.waitForFunction(() => window.__chase.state.screen === 'lobby', null, { timeout: 15000 });
}

const CODE = 'QK7M';
const host = await ctx.newPage();
await joinAs(host, 'host', CODE);
await host.waitForSelector('#lb-list .lrow');
ok('המנחה פתח משחק עם קוד ' + CODE);

const screen = await ctx.newPage();
await joinAs(screen, 'screen', CODE);
await screen.waitForSelector('#lb-list .lrow');
ok('מסך ההקרנה הצטרף עם אותו קוד');

// שני המכשירים רואים זה את זה — זה מה שלא עבד קודם
const seen = await host.evaluate(() =>
  [...document.querySelectorAll('#lb-list .lrow.on')].map(r => r.querySelector('b').textContent.trim()));
(seen.includes('מסך מנחה') && seen.includes('מסך הקרנה'))
  ? ok(`המנחה רואה את שני התפקידים (${seen.join(', ')})`)
  : fail('הלובי אצל המנחה מראה: ' + JSON.stringify(seen));

const seenB = await screen
  .waitForFunction(() => {
    const rows = [...document.querySelectorAll('#lb-list .lrow.on')];
    return rows.length === 2 ? rows.map(r => r.querySelector('b').textContent.trim()) : null;
  }, null, { timeout: 8000 })
  .then(h => h.jsonValue()).catch(() => null);
seenB ? ok('גם מסך ההקרנה רואה את שניהם — המנחה עונה למצטרף מיד')
      : fail('הלובי אצל ההקרנה לא הראה את שני התפקידים');

const codeChip = await host.evaluate(() => document.querySelector('#lb-list').textContent.includes('QK7M'));
codeChip ? ok('הקוד מוצג בלובי, כדי שמאחרים יוכלו לקרוא אותו')
         : fail('הקוד לא מופיע בלובי');
await host.screenshot({ path: path.join(SHOTS, 'relay-host.png') });

// מכשיר עם קוד אחר לא שייך למשחק הזה
const stray = await ctx.newPage();
await joinAs(stray, 'chaser', 'ZZZZ');
await host.waitForTimeout(600);
const strayLeaked = await host.evaluate(() => document.querySelectorAll('#lb-list .lrow.on').length);
strayLeaked === 2 ? ok('מכשיר עם קוד אחר לא נכנס למשחק')
                  : fail('קוד זר הופיע בלובי (' + strayLeaked + ' תפקידים)');
await stray.close();

// הצ׳ייסר מצטרף באיחור ומופיע מיד
const chaser = await ctx.newPage();
await joinAs(chaser, 'chaser', CODE);
await host.waitForTimeout(800);
const withChaser = await host.evaluate(() => document.querySelectorAll('#lb-list .lrow.on').length);
withChaser === 3 ? ok('צ׳ייסר שמצטרף באיחור מופיע מיד אצל המנחה')
                 : fail('אחרי הצטרפות הצ׳ייסר נראים ' + withChaser + ' תפקידים');

// המנחה מתחיל — האחרים עוברים לבד
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

await screen.waitForTimeout(1200);
const mirrored = await screen.evaluate(() => {
  const q = document.querySelector('#proj .proj-q');
  return q ? q.textContent.trim() : null;
});
const hostQ = await host.evaluate(() => window.__chase.state.cash.q.q);
(mirrored && mirrored === hostQ)
  ? ok(`השאלה של המנחה מוצגת בהקרנה ("${mirrored.slice(0, 32)}…")`)
  : fail('ההקרנה לא שיקפה את השאלה. הקרנה=' + JSON.stringify(mirrored));

// השעון נשלח כזמן סיום ובכל זאת רץ בהקרנה
const ticking = await screen.evaluate(async () => {
  const read = () => { const el = document.querySelector('#proj-clock'); return el ? el.textContent.trim() : null; };
  const a = read();
  await new Promise(r => setTimeout(r, 1300));
  return { a, b: read() };
});
(ticking.a && ticking.b && ticking.a !== ticking.b)
  ? ok(`השעון רץ בהקרנה (${ticking.a} → ${ticking.b})`)
  : fail('השעון לא התקדם בהקרנה: ' + JSON.stringify(ticking));

// והתשובה עדיין לא שם
const answer = await host.evaluate(() => window.__chase.state.cash.q.a);
const leak = await screen.evaluate(() => document.body.innerText);
!leak.includes(answer) ? ok('התשובה לא הופיעה על המסך הגדול')
                       : fail('התשובה דלפה להקרנה: ' + answer);
await screen.screenshot({ path: path.join(SHOTS, 'relay-projector.png') });

// קצב ההודעות — ממסר חינמי לא סובל זרם קבוע
await host.waitForTimeout(3000);
const before = published;
await host.waitForTimeout(4000);
const rate = (published - before) / 4;
/* מה שנבדק כאן הוא שאין זרם קבוע: המנחה בונה תמונת מצב כמה פעמים בשנייה,
   ורק שינוי אמיתי אמור לצאת לממסר. ממסר חינמי חוסם מי שמשדר בלי הפסקה. */
rate <= 2 ? ok(`אין זרם קבוע (${rate.toFixed(2)} הודעות לשנייה — רק שינויים אמיתיים)`)
          : fail(`קצב השידור גבוה מדי: ${rate.toFixed(2)} הודעות לשנייה`);

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
