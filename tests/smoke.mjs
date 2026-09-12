/**
 * בדיקת עשן מקצה לקצה למשחק "הצ'ייסר".
 *
 * מריצה משחק שלם בדפדפן אמיתי: תפריט → הגדרות → צבירת כסף → הצעה →
 * מרדף אישי (ניצחון והפסד) → מרדף סופי → מסך תוצאות, ומצלמת כל מסך.
 *
 * הרצה:
 *   node tests/smoke.mjs           (משתמש ב-playwright מקומי או גלובלי)
 * אופציונלי:
 *   SHOTS=/path/to/dir   יעד לצילומי המסך (ברירת מחדל: ./.screenshots)
 *   BASE=http://localhost:8000/index.html   כתובת חלופית (ברירת מחדל: file://)
 *
 * המשחק נטען עם ?fast=1 — דגל פיתוח שמקצר את כל הטיימרים.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/* playwright מותקן לפעמים רק גלובלית — מאתרים אותו בשתי הדרכים */
const require_ = createRequire(import.meta.url);
function loadPlaywright(){
  try { return require_('playwright'); } catch {}
  try {
    const globalRoot = execSync('npm root -g', { encoding:'utf8' }).trim();
    return createRequire(path.join(globalRoot, 'x.js'))('playwright');
  } catch (e){
    console.error('לא נמצא playwright. התקינו אותו: npm i -D playwright');
    process.exit(2);
  }
}
const { chromium } = loadPlaywright();

const root  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE  = process.env.BASE || pathToFileURL(path.join(root, 'index.html')).href;
const SHOTS = process.env.SHOTS || path.join(root, '.screenshots');
const URL_  = BASE + (BASE.includes('?') ? '&' : '?') + 'fast=1';

fs.mkdirSync(SHOTS, { recursive: true });

const CDN = /cdn\.tailwindcss\.com|fonts\.(googleapis|gstatic)\.com/;
let failures = 0;
const problems = [];

const ok   = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = m => { failures++; problems.push(m); console.log('  \x1b[31m✗\x1b[0m ' + m); };

async function shot(page, tag, name){
  await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`), fullPage: false });
}

/** מחכה עד ש-window.__chase.state.screen הוא אחד מהמסכים המבוקשים */
async function waitScreen(page, screens, timeout = 30000){
  const list = [].concat(screens);
  await page.waitForFunction(
    s => s.includes(window.__chase.state.screen),
    list, { timeout }
  );
  return page.evaluate(() => window.__chase.state.screen);
}

async function playChase(page, { win }){
  // לולאת שאלות במרדף האישי: בוחרים תמיד נכון (ניצחון) או תמיד שגוי (הפסד)
  for (let i = 0; i < 40; i++){
    const phase = await page.evaluate(() => window.__chase.state.chase?.phase);
    if (phase === 'done') break;
    try {
      await page.waitForFunction(
        () => window.__chase.state.chase?.phase === 'answering'
              && document.querySelectorAll('#opts .opt:not([disabled])').length === 3,
        null, { timeout: 15000 });
    } catch { break; }
    const pick = await page.evaluate(win => {
      const s = window.__chase.state.chase;
      const right = s.q.shuffled.indexOf(s.q.a);
      return win ? right : (right + 1) % 3;
    }, win);
    await page.click(`#opts .opt[data-pick="${pick}"]`);
    await page.waitForTimeout(400);
  }
}

async function run(tag, viewport){
  console.log(`\n▶ מסלול מלא ב-${viewport.width}px`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, locale: 'he-IL' });
  const page = await ctx.newPage();

  const consoleErrors = [], cdnBlocked = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  page.on('requestfailed', r => { if (CDN.test(r.url())) cdnBlocked.push(r.url()); });

  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#m-new');
  await shot(page, tag, '01-menu');
  ok('התפריט נטען');

  // --- שאלה משפחתית מותאמת ---
  await page.click('#m-custom');
  await page.fill('#c-q',  'מה שם הכלב של המשפחה?');
  await page.fill('#c-a',  'לונה');
  await page.fill('#c-w1', 'רקסי');
  await page.fill('#c-w2', 'צ׳ארלי');
  await page.click('#c-form button[type="submit"]');
  const customCount = await page.textContent('#c-count');
  customCount.trim() === '1' ? ok('שאלה משפחתית נשמרה') : fail('שאלה משפחתית לא נשמרה (' + customCount + ')');
  await shot(page, tag, '02-custom');

  // --- הגדרות ---
  await page.click('#c-play');
  await page.waitForSelector('#s-start');
  await page.click('[data-count="2"]');
  await page.fill('[data-name="0"]', 'נועה');
  await page.fill('[data-name="1"]', 'איתי');
  await page.click('[data-lvl="medium"]');
  await page.click('[data-ansmode="host"]');
  await shot(page, tag, '03-setup');
  await page.click('#s-start');

  // ============ שחקן 1 — מגיע הביתה ============
  await waitScreen(page, 'ready');
  await shot(page, tag, '04-ready');
  await page.click('#go');
  await waitScreen(page, 'cash');

  // מי שמשפט חייב לראות את התשובה עוד לפני שהוא מחליט
  await page.waitForSelector('#judge-text');
  const card = await page.evaluate(() => ({
    shown:  !document.getElementById('judge-answer').hidden,
    text:   document.getElementById('judge-text').textContent.trim(),
    answer: window.__chase.state.cash.q.a
  }));
  (card.shown && card.text && card.text === card.answer)
    ? ok(`כרטיס המנחה מציג את התשובה מראש ("${card.text}")`)
    : fail('התשובה אינה גלויה למנחה לפני השיפוט: ' + JSON.stringify(card));

  for (let i = 0; i < 6; i++){
    if (await page.isEnabled('#b-ok').catch(() => false)) await page.click('#b-ok');
    await page.waitForTimeout(120);
  }
  await page.click('#b-pass').catch(() => {});
  await shot(page, tag, '05-cash');
  const bank = await page.evaluate(() => window.__chase.state.cash.bank);
  bank > 0 ? ok(`צבירת כסף עובדת (${bank} ₪)`) : fail('לא נצבר כסף בסבב הראשון');

  await waitScreen(page, 'offer', 40000);
  await shot(page, tag, '06-offer');
  const offers = await page.evaluate(() => {
    const p = window.__chase.state.players[0];
    return window.__chase.makeOffers(p.bank, window.__chase.state.chaser);
  });
  (offers.low < Math.max(offers.mid, 1) && offers.high > offers.mid)
    ? ok(`הצעות תקינות (${offers.low} / ${offers.mid} / ${offers.high})`)
    : fail('סדר ההצעות שגוי: ' + JSON.stringify(offers));

  await page.click('[data-offer="mid"]');
  await waitScreen(page, 'chase');
  await page.waitForTimeout(600);
  await shot(page, tag, '07-chase');
  await playChase(page, { win: true });
  const p1 = await page.evaluate(() => window.__chase.state.players[0].status);
  p1 === 'safe' ? ok('שחקן שעונה נכון מגיע הביתה') : fail('שחקן 1 לא הגיע הביתה (' + p1 + ')');
  await shot(page, tag, '08-chase-home');

  // ============ שחקן 2 — נתפס ============
  await waitScreen(page, ['ready', 'finalIntro'], 30000);
  if (await page.evaluate(() => window.__chase.state.screen) === 'ready'){
    await page.click('#go');
    await waitScreen(page, 'cash');
    for (let i = 0; i < 3; i++){
      if (await page.isEnabled('#b-ok').catch(() => false)) await page.click('#b-ok');
      await page.waitForTimeout(120);
    }
    await waitScreen(page, 'offer', 40000);
    await page.click('[data-offer="high"]');
    await waitScreen(page, 'chase');
    await playChase(page, { win: false });
    const p2 = await page.evaluate(() => window.__chase.state.players[1].status);
    p2 === 'out' ? ok('שחקן שעונה שגוי נתפס') : fail('שחקן 2 לא נתפס (' + p2 + ')');
    await shot(page, tag, '09-chase-caught');
  }

  // ============ מרדף סופי ============
  const scr = await waitScreen(page, ['finalIntro', 'results'], 40000);
  if (scr === 'finalIntro'){
    await shot(page, tag, '10-final-intro');
    if (await page.isVisible('#f-go')){
      await page.click('#f-go');
      await waitScreen(page, 'finalTeam', 20000);
      for (let i = 0; i < 8; i++){
        if (await page.isEnabled('#b-ok').catch(() => false)) await page.click('#b-ok');
        await page.waitForTimeout(110);
      }
      await shot(page, tag, '11-final-team');
      const steps = await page.evaluate(() => window.__chase.state.final.teamSteps);
      steps > await page.evaluate(() => window.__chase.state.final.headStart)
        ? ok(`הקבוצה צברה צעדים (${steps})`) : fail('הקבוצה לא צברה צעדים');

      await waitScreen(page, 'finalChaser', 40000);
      await page.waitForTimeout(900);
      await shot(page, tag, '12-final-chaser');
      ok('תור הצ׳ייסר התחיל');
    } else {
      await page.click('#f-skip');
    }
  }

  await waitScreen(page, 'results', 90000);
  await page.waitForTimeout(500);
  await shot(page, tag, '13-results');
  const out = await page.evaluate(() => document.querySelector('#again') !== null);
  out ? ok('מסך התוצאות הוצג') : fail('מסך התוצאות לא הוצג');

  // --- ניקוי + בדיקות סביבה ---
  if (cdnBlocked.length) console.log(`  \x1b[33m•\x1b[0m ה-CDN לא נטען (${cdnBlocked.length} בקשות) — המשחק רץ על העיצוב המקומי`);
  const real = consoleErrors.filter(e => !CDN.test(e) && !/Failed to load resource/i.test(e));
  real.length ? fail('שגיאות קונסולה: ' + real.slice(0, 4).join(' | ')) : ok('אין שגיאות קונסולה');

  await ctx.close();
  await browser.close();
}

/** מצב "מסך שכולם רואים": התשובה מוסתרת עד שלוחצים להציג */
async function runSharedScreen(){
  console.log('\n▶ מצב מסך משותף');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' })).newPage();
  await page.goto(URL_, { waitUntil:'domcontentloaded' });

  await page.click('#m-new');
  await page.waitForSelector('#s-start');
  await page.click('[data-count="1"]');
  await page.click('[data-ansmode="shared"]');
  await page.click('#s-start');
  await waitScreen(page, 'ready');
  await page.click('#go');
  await waitScreen(page, 'cash');
  await page.waitForSelector('#judge-peek');

  const before = await page.evaluate(() => ({
    hidden: document.getElementById('judge-answer').hidden,
    peek:  !document.getElementById('judge-peek').hidden
  }));
  (before.hidden && before.peek)
    ? ok('במסך משותף התשובה מוסתרת ומוצע כפתור הצגה')
    : fail('התשובה דלפה במצב מסך משותף: ' + JSON.stringify(before));

  await page.click('#judge-peek');
  const after = await page.evaluate(() => ({
    shown: !document.getElementById('judge-answer').hidden,
    text:   document.getElementById('judge-text').textContent.trim(),
    answer: window.__chase.state.cash.q.a
  }));
  (after.shown && after.text === after.answer)
    ? ok('לחיצה על "הצג תשובה" חושפת את התשובה הנכונה')
    : fail('הצגת התשובה נכשלה: ' + JSON.stringify(after));

  await page.screenshot({ path: path.join(SHOTS, 'shared-peek.png') });
  await browser.close();
}

console.log('בדיקת עשן — הצ׳ייסר\nכתובת: ' + URL_);
await run('desktop', { width: 1280, height: 900 });
await run('mobile',  { width: 390,  height: 844 });
await runSharedScreen();

console.log('\nצילומי מסך: ' + SHOTS);
if (failures){
  console.log(`\n\x1b[31m${failures} בדיקות נכשלו\x1b[0m`);
  problems.forEach(p => console.log(' - ' + p));
  process.exit(1);
}
console.log('\n\x1b[32mכל הבדיקות עברו\x1b[0m');
