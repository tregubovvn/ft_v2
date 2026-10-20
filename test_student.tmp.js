const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const latexFrag = fs.readFileSync('js/latex-fragments.js', 'utf8');
const appJs = fs.readFileSync('js/app.js', 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.eval(`window.katex = { renderToString: (t) => '<span>' + t + '</span>' };
window.jsQR = () => null;
window.fetch = () => Promise.reject(new Error('no network'));`);

// expose internal bindings for the test harness
window.eval(latexFrag);
window.eval(appJs + '\n;window.__T = { setQuiz(title, f){ quizTitle=title; formulas=f; }, get fragments(){ return currentFragments.slice(); } };');

const T = window.__T;
const d = window.document;
let failures = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) failures++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startTest() {
  d.getElementById('lastName').value = arguments[0];
  d.getElementById('firstName').value = arguments[1];
  d.getElementById('lastName').dispatchEvent(new window.Event('input'));
  d.getElementById('firstName').dispatchEvent(new window.Event('input'));
  check('start enabled after inputs', !d.getElementById('startBtn').disabled);
  d.getElementById('startBtn').click();
  check('main screen active after start', d.getElementById('mainScreen').classList.contains('active'));
}

(async () => {
  // ===== Scenario 1: «Завершить» on first task without answering =====
  T.setQuiz('Сопротивление материалов', [
    { name: 'Закон Ома', latex: 'U = I \\cdot R', symbols: [] },
    { name: 'Мощность', latex: 'P = U \\cdot I', symbols: [] },
    { name: 'Работа', latex: 'A = P \\cdot t', symbols: [] },
  ]);
  startTest('Иванов И.И.', 'МЕНЖ-21');

  const finishBtn = d.getElementById('finishBtn');
  check('finish button exists', !!finishBtn);
  finishBtn.click();
  check('result screen active after Завершить', d.getElementById('resultScreen').classList.contains('active'));

  const text = (d.getElementById('submissionSummary').textContent || '').replace(/\s+/g, ' ');
  console.log('SUMMARY TEXT:', JSON.stringify(text.slice(0, 320)));
  check('summary rendered (not empty)', text.trim().length > 0);
  check('summary ФИО correct', text.includes('ФИО: Иванов И.И.'));
  check('summary Группа correct', text.includes('Группа: МЕНЖ-21'));
  check('summary Тема теста', text.includes('Тема теста: Сопротивление материалов'));
  check('summary Дата и время сдачи', /Дата и время сдачи:\s*\d{1,2}\.\d{1,2}\.\d{4}/.test(text));
  check('summary Затраченное время sane', /Затраченное время:\s*0{2}:\d{2}/.test(text));
  check('ФИО row does not duplicate group', !/ФИО: Иванов И\.И\. МЕНЖ-21/.test(text));
  check('one task recorded as wrong', d.getElementById('wrongAnswers').textContent === '1');
  check('total formulas = 3', d.getElementById('totalFormulas').textContent === '3');

  // ===== Scenario 2: full correct flow Проверить -> Дальше x3 =====
  d.getElementById('restartBtn').click();
  check('back to welcome after restart', d.getElementById('welcomeScreen').classList.contains('active'));
  startTest('Петров П.П.', 'ГР-2');

  for (let i = 0; i < 3; i++) {
    await sleep(1550); // let loadCurrentFormula settle after previous «Дальше»
    const expected = T.fragments;
    for (const frag of expected) {
      const chip = Array.from(d.querySelectorAll('#fragmentsContainer .fragment'))
        .find(el => el.dataset.fragment === frag && !el.classList.contains('placed'));
      if (!chip) throw new Error('chip missing for ' + frag);
      chip.click();
    }
    check(`task ${i+1}: «Проверить» enabled when complete`, !d.getElementById('checkBtn').disabled);
    check(`task ${i+1}: «Дальше» disabled before check`, d.getElementById('checkBtnNext').disabled);
    d.getElementById('checkBtn').click();
    check(`task ${i+1}: «Дальше» enabled after correct check`, !d.getElementById('checkBtnNext').disabled);
    d.getElementById('checkBtnNext').click();
  }
  await sleep(1600);
  check('after last «Дальше» result screen shown', d.getElementById('resultScreen').classList.contains('active'));
  check('all 3 correct, no double counting',
    d.getElementById('correctAnswers').textContent === '3' && d.getElementById('wrongAnswers').textContent === '0');
  const t2 = (d.getElementById('submissionSummary').textContent || '').replace(/\s+/g, ' ');
  check('scenario2 summary has Петров/ГР-2', t2.includes('Петров П.П.') && t2.includes('ГР-2'));
  check('scenario2 mark = 5', d.getElementById('studentResult').textContent === '5');

  // ===== Scenario 3: wrong answer then Завершить — recorded once =====
  d.getElementById('restartBtn').click();
  startTest('Сидоров', 'ГР-3');
  await sleep(1550);
  const exp = T.fragments;
  // place fragments in reversed order
  [...exp].reverse().forEach(frag => {
    const chip = Array.from(d.querySelectorAll('#fragmentsContainer .fragment'))
      .find(el => el.dataset.fragment === frag && !el.classList.contains('placed'));
    chip.click();
  });
  d.getElementById('checkBtn').click();               // wrong check → recorded as wrong
  check('sc3: «Дальше» stays disabled after wrong check', d.getElementById('checkBtnNext').disabled);
  d.getElementById('finishBtn').click();              // finish must NOT record again
  const t3 = (d.getElementById('submissionSummary').textContent || '');
  check('sc3: exactly 1 wrong, 0 extra records',
    d.getElementById('wrongAnswers').textContent === '1' && d.getElementById('correctAnswers').textContent === '0');

  console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
