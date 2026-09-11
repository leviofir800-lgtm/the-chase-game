/**
 * ממיר את index.html לגרסה שמתאימה לפרסום כ-Artifact.
 *
 * Artifact עוטף את הקובץ שמפרסמים ב-<!doctype html><head>…</head><body> משלו,
 * ולכן הקובץ המפורסם לא יכול לשאת מעטפת מסמך משלו. הסקריפט מסיר את המעטפת,
 * משאיר את <title> ואת <style> בראש הקובץ, ומחזיר את מצב ה-RTL שאבד יחד עם
 * תגית <html dir="rtl">.
 *
 * הרצה:  node tools/make-artifact.mjs [קובץ-יעד]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src  = path.join(root, 'index.html');
const out  = process.argv[2] || path.join(root, '.artifact', 'chase-artifact.html');

let html = fs.readFileSync(src, 'utf8');
const must = (cond, msg) => { if (!cond){ console.error('✗ ' + msg); process.exit(1); } };

// 1. מעטפת המסמך — מסופקת על ידי Artifact
html = html
  .replace(/<!DOCTYPE html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<body>\s*/i, '')
  .replace(/<\/body>\s*/i, '')
  .replace(/<\/html>\s*/i, '');

// 2. תגיות meta שהמעטפת כבר מספקת
html = html
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace(/<meta name="theme-color"[^>]*>\s*/i, '');

// 3. מטפל inline על תגית הסקריפט — נחסם על ידי ה-CSP של Artifact.
//    ההגדרה ממילא לא בשימוש בסימון עצמו, ולכן פשוט מסירים אותה.
html = html.replace(/\s*onload="if\(window\.tailwind\)[^"]*"/i, '');

// 4. שם ה-Artifact הוא שם בלבד, בלי תיאור אחרי המקף
html = html.replace(/<title>[^<]*<\/title>/i, '<title>הצ׳ייסר</title>');

// 5. החזרת RTL — לא ניתן להצהיר עליו יותר על תגית השורש
html = html.replace('<main id="app" class="wrap"></main>', '<main id="app" class="wrap" dir="rtl"></main>');
html = html.replace('<div id="overlay-root"></div>', '<div id="overlay-root" dir="rtl"></div>');
html = html.replace('<div id="bgfx"></div>', `<script>
  /* הכיוון והשפה הוגדרו במקור על תגית השורש, שאינה חלק מהקובץ המפורסם */
  document.documentElement.setAttribute('dir', 'rtl');
  document.documentElement.setAttribute('lang', 'he');
</script>
<div id="bgfx"></div>`);

// --- בדיקות שהפלט עומד בחוזה של Artifact ---
must(!/<!doctype/i.test(html),               'נותרה תגית doctype');
must(!/<html[\s>]/i.test(html),              'נותרה תגית html');
must(!/<\/?head>/i.test(html),               'נותרה תגית head');
must(!/<body[\s>]|<\/body>/i.test(html),     'נותרה תגית body');
must(!/\sonload=/i.test(html),               'נותר מטפל onload בתוך הסימון');
must(!/\b(confirm|alert)\(/.test(html),      'נותרה חלונית מערכת (confirm/alert)');
const head8k = html.slice(0, 8192);
must(/<title>/i.test(head8k),                '<title> אינו ב-8KB הראשונים');
must(html.includes('id="app"') && html.includes('id="overlay-root"'), 'חסר עוגן של המשחק');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`✓ נוצר: ${out}  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
