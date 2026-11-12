/* =========================================================================
 * Formula Builder — application logic (extracted from the inline <script>).
 * Requires: KaTeX, jsQR and js/latex-fragments.js (parseLatexToFragments).
 * ========================================================================= */
'use strict';

// ============ CONSTANTS ============
const YANDEX_DISK_DOWNLOAD_API = 'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=';
const HINT_TEXT = 'Перетащите фрагменты сюда в правильном порядке';
const QR_SCAN_INTERVAL_MS = 200;
const NEXT_FORMULA_DELAY_MS = 1500;
const WRONG_ANSWER_PENALTY = 0.03;   // доля процента, снимаемая за каждую ошибку

// ============ STATE ============
let formulas = [];
let quizTitle = '';
let currentFormulaIndex = 0;
let correctCount = 0;
let wrongCount = 0;
let results = [];
let currentFragments = [];
let placedFragments = [];
// true, если результат текущего задания уже записан в results
// (кнопками «Проверить»/«Дальше»/«Завершить») — защита от двойного учёта.
let answerRecorded = false;
// lastName — ФИО студента, firstName — группа (исторически сложившиеся id полей)
let studentData = { lastName: '', group: '' };
let resultFormUrl = null;
let testStartTime = 0;
let timerInterval = null;
let totalTestTime = 0;
let draggedElement = null;
let videoStream = null;
let scanInterval = null;

// ============ DOM ELEMENTS ============
const screens = {
    welcome: document.getElementById('welcomeScreen'),
    main: document.getElementById('mainScreen'),
    result: document.getElementById('resultScreen'),
};

const $ = (id) => document.getElementById(id);

const elements = {
    lastName: $('lastName'),
    firstName: $('firstName'),   // поле «Группа» (исторический id)
    fileDropZone: $('fileDropZone'),
    fileInput: $('fileInput'),
    urlInput: $('urlInput'),
    loadUrlBtn: $('loadUrlBtn'),
    scanQrBtn: $('scanQrBtn'),
    formulasStatus: $('formulasStatus'),
    formulasCount: $('formulasCount'),
    startBtn: $('startBtn'),
    validationMessage: $('validationMessage'),
    studentName: $('studentName'),
    formulaCounter: $('formulaCounter'),
    progressFill: $('progressFill'),
    formulaName: $('formulaName'),
    dropZone: $('dropZone'),
    fragmentsContainer: $('fragmentsContainer'),
    resetBtn: $('resetBtn'),
    checkBtn: $('checkBtn'),
    checkBtnNext: $('checkBtnNext'),
    finishBtn: $('finishBtn'),
    resultSummary: $('resultSummary'),
    resultsDetails: $('resultsDetails'),
    restartBtn: $('restartBtn'),
    qrModal: $('qrModal'),
    qrVideo: $('qrVideo'),
    qrCanvas: $('qrCanvas'),
    qrStatus: $('qrStatus'),
    closeQrBtn: $('closeQrBtn'),
    timerDisplay: $('timerDisplay'),
    symbolsContainer: $('symbolsContainer'),
    submissionStatus: $('submissionStatus'),
    trackerCard: $('trackerCard'),
    trackerStudentIdInput: $('trackerStudentIdInput'),
    trackerSaveBtn: $('trackerSaveBtn'),
    trackerStatus: $('trackerStatus'),
};

// ============ UTILITIES ============
function showScreen(screenName) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenName].classList.add('active');
}

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Чч:Мм:Сс (как в rt_v2 / mt_v2) для итоговой сводки.
function formatClock(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = n => n.toString().padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Date -> «дд.мм.гггг, чч:мм:сс» (ru-RU), как в mt_v2.
function formatDateTime(date) {
    return date.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Escape text before inserting it into innerHTML (names come from the XML file).
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderLatexInline(latex) {
    try {
        return katex.renderToString(latex, { throwOnError: false });
    } catch (e) {
        return latex;
    }
}

function renderLatexDisplay(latex, element) {
    try {
        katex.render(latex, element, { throwOnError: false, displayMode: true });
    } catch (e) {
        element.textContent = latex;
    }
}

// ============ TIMER ============
function startTimer() {
    testStartTime = Date.now();
    totalTestTime = 0;
    timerInterval = setInterval(() => {
        elements.timerDisplay.textContent = formatTime(Date.now() - testStartTime);
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    // Время сдачи корректно только если таймер действительно запускался.
    if (testStartTime > 0) totalTestTime = Date.now() - testStartTime;
    return totalTestTime;
}

// ============ FORMULA LOADING (XML) ============
function parseFormulaNode(node) {
    const name = node.getAttribute('name') || 'Формула';
    const latexNode = node.querySelector('latex');
    const latex = (latexNode ? latexNode.textContent : node.textContent).trim();

    const symbols = [];
    const symbolsNode = node.querySelector('symbols');
    if (symbolsNode) {
        symbolsNode.querySelectorAll('symbol').forEach(s => {
            symbols.push({ char: s.getAttribute('char') || '', name: s.getAttribute('name') || '' });
        });
    }
    return { name, latex, symbols };
}

function loadFormulas(xmlString) {
    const xmlDoc = new DOMParser().parseFromString(xmlString, 'text/xml');
    formulas = Array.from(xmlDoc.querySelectorAll('formula'))
        .map(parseFormulaNode)
        .filter(f => f.latex);

    // Тема теста: атрибут name корня <quiz>, иначе первый <title> или <name>
    const root = xmlDoc.documentElement;
    quizTitle = (root && root.getAttribute('name')) || '';
    if (!quizTitle) {
        const titleNode = xmlDoc.querySelector('title') || xmlDoc.querySelector('name');
        if (titleNode) quizTitle = (titleNode.textContent || '').trim();
    }

    if (formulas.length > 0) {
        elements.formulasStatus.classList.remove('hidden');
        elements.formulasCount.textContent = formulas.length;
    }
    updateStartButton();
}

function loadFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => loadFormulas(e.target.result);
    reader.readAsText(file);
}

// ============ URL / YANDEX DISK LOADING ============
function isYandexDiskUrl(url) {
    return url.includes('yadi.sk') || url.includes('disk.yandex');
}

async function fetchFromYandexDisk(url) {
    // 1. Resolve a direct download link through the Yandex.Disk API.
    const metaResponse = await fetch(YANDEX_DISK_DOWNLOAD_API + encodeURIComponent(url));
    if (!metaResponse.ok) throw new Error(`Ошибка HTTP: ${metaResponse.status}`);

    const data = await metaResponse.json();
    if (!data.href) throw new Error('Не удалось получить ссылку для скачивания');

    // 2. Download the file itself.
    const fileResponse = await fetch(data.href);
    if (!fileResponse.ok) throw new Error(`Ошибка загрузки файла: ${fileResponse.status}`);

    const xmlContent = await fileResponse.text();
    if (!xmlContent.trim().startsWith('<')) console.warn('Загруженный файл не похож на XML');
    return xmlContent;
}

function describeFetchError(error) {
    const message = error.message || '';
    if (message.includes('403')) return 'Ошибка 403: Доступ запрещен. Проверьте права доступа к файлу';
    if (message.includes('404')) return 'Ошибка 404: Файл не найден. Проверьте ссылку и права доступа';
    if (message.includes('Failed to fetch')) return 'Ошибка сети. Проверьте подключение или попробуйте другую ссылку.';
    return message;
}

async function loadFromUrl(url) {
    if (!url) {
        showUploadStatus('Пожалуйста, введите ссылку', 'error');
        return;
    }

    elements.loadUrlBtn.disabled = true;
    showUploadStatus('Загрузка...', 'loading');

    try {
        const xmlContent = isYandexDiskUrl(url)
            ? await fetchFromYandexDisk(url)
            : await (async () => {
                const response = await fetch(url);
                if (!response.ok) throw new Error('Ошибка загрузки по ссылке');
                return response.text();
            })();

        loadFormulas(xmlContent);

        if (formulas.length > 0) {
            showUploadStatus(`Успешно загружено формул: ${formulas.length}`, 'success');
        } else {
            showUploadStatus('Не удалось найти формулы в файле', 'error');
        }
    } catch (error) {
        showUploadStatus('Ошибка: ' + describeFetchError(error), 'error');
        console.error('Детали ошибки:', error);
    } finally {
        elements.loadUrlBtn.disabled = false;
    }
}

// ============ TEST FLOW ============
function loadCurrentFormula() {
    if (currentFormulaIndex >= formulas.length) {
        showResults();
        return;
    }
    const formula = formulas[currentFormulaIndex];
    elements.formulaName.textContent = formula.name;
    elements.formulaCounter.textContent = `${currentFormulaIndex + 1} / ${formulas.length}`;
    elements.progressFill.style.width = `${(currentFormulaIndex / formulas.length) * 100}%`;

    currentFragments = parseLatexToFragments(formula.latex);
    resetFormulaState();
    renderSymbols(formula.symbols);
    renderFragments();
    resetDropZone();
}

function renderSymbols(symbols) {
    if (!symbols || symbols.length === 0) {
        elements.symbolsContainer.style.display = 'none';
        elements.symbolsContainer.innerHTML = '';
        return;
    }
    elements.symbolsContainer.style.display = 'block';
    elements.symbolsContainer.innerHTML =
        '<p class="symbols-title">Условные обозначения</p>' +
        symbols.map(s => `
            <div class="symbol-item">
                <div class="symbol-char">${renderLatexInline(s.char)}</div>
                <div class="symbol-dash">—</div>
                <div class="symbol-name">${escapeHtml(s.name)}</div>
            </div>`).join('');
}

function renderFragments() {
    elements.fragmentsContainer.innerHTML = '';
    shuffleArray(currentFragments).forEach((fragment, index) => {
        const el = document.createElement('div');
        el.className = 'fragment';
        el.draggable = true;
        el.dataset.fragment = fragment;
        el.dataset.index = index;
        el.innerHTML = renderLatexInline(fragment);
        el.addEventListener('dragstart', handleDragStart);
        el.addEventListener('dragend', handleDragEnd);
        el.addEventListener('click', handleFragmentClick);
        elements.fragmentsContainer.appendChild(el);
    });
}

// Обновляет состояние кнопок «Проверить»/«Дальше»: «Проверить» доступна,
// когда собран полный ответ; «Дальше» — только после правильной проверки.
function updateCheckButton() {
    const complete = placedFragments.length === currentFragments.length;
    elements.checkBtn.disabled = !complete;
    elements.checkBtnNext.disabled = !(complete && answerRecorded && isAnswerCorrect());
}

function updateStartButton() {
    const hasName = elements.lastName.value.trim() && elements.firstName.value.trim();
    const hasFormulas = formulas.length > 0;
    elements.startBtn.disabled = !(hasName && hasFormulas);

    let message = '';
    if (!hasFormulas && !hasName) message = 'Введите ФИО и загрузите формулы';
    else if (!hasName) message = 'Введите ФИО для начала теста';
    else if (!hasFormulas) message = 'Загрузите формулы для начала теста';

    elements.validationMessage.textContent = message;
    elements.validationMessage.style.opacity = message ? '1' : '0';
}

function showUploadStatus(message, type) {
    elements.validationMessage.textContent = message;
    elements.validationMessage.style.opacity = '1';
    const colors = { error: 'var(--error)', success: 'var(--success)' };
    elements.validationMessage.style.color = colors[type] || 'var(--accent)';
}

// ============ DRAG AND DROP / CLICK-TO-PLACE ============
function moveFragmentToDropZone(fragment) {
    const hint = elements.dropZone.querySelector('.hint-text');
    if (hint) hint.remove();
    elements.dropZone.appendChild(fragment);
    fragment.classList.add('placed');
    elements.dropZone.classList.add('has-items');
    placedFragments.push(fragment.dataset.fragment);
}

function moveFragmentBack(fragment) {
    elements.fragmentsContainer.appendChild(fragment);
    fragment.classList.remove('placed');
    placedFragments = placedFragments.filter(f => f !== fragment.dataset.fragment);
    if (placedFragments.length === 0) {
        elements.dropZone.innerHTML = `<p class="hint-text">${HINT_TEXT}</p>`;
        elements.dropZone.classList.remove('has-items');
    }
}

function handleDragStart(e) {
    draggedElement = e.target.closest('.fragment');
    if (draggedElement) {
        draggedElement.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    }
}

function handleDragEnd() {
    if (draggedElement) {
        draggedElement.classList.remove('dragging');
        draggedElement = null;
    }
}

function handleFragmentClick(e) {
    const fragment = e.target.closest('.fragment');
    if (!fragment) return;
    if (elements.dropZone.contains(fragment)) moveFragmentBack(fragment);
    else moveFragmentToDropZone(fragment);
    updateCheckButton();
}

function resetDropZone() {
    elements.dropZone.innerHTML = `<p class="hint-text">${HINT_TEXT}</p>`;
    elements.dropZone.classList.remove('has-items');
    placedFragments = [];
    updateCheckButton();
}

function bindDropZoneEvents() {
    elements.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.dropZone.classList.add('drag-over');
    });
    elements.dropZone.addEventListener('dragleave', () => {
        elements.dropZone.classList.remove('drag-over');
    });
    elements.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('drag-over');
        if (draggedElement && !elements.dropZone.contains(draggedElement)) {
            moveFragmentToDropZone(draggedElement);
            updateCheckButton();
        }
    });
}

// ============ CHECK ANSWER ============
function isAnswerCorrect() {
    return JSON.stringify(currentFragments) === JSON.stringify(placedFragments);
}

function showFeedback(correct) {
    elements.dropZone.querySelectorAll('.fragment').forEach(f => {
        f.classList.add(correct ? 'correct' : 'incorrect');
    });
}

// Проверка ответа (кнопка «Проверить»): показывает обратную связь,
// фиксирует результат текущего задания (один раз) и разблокирует
// «Дальше», если ответ правильный.
function checkAnswer() {
    const correct = isAnswerCorrect();
    recordCurrentResult();
    showFeedback(correct);
    updateCheckButton();
}

// Запись результата текущего задания в статистику (без повторов).
function recordCurrentResult() {
    if (answerRecorded) return;
    const formula = formulas[currentFormulaIndex];
    if (!formula) return;
    const correct = isAnswerCorrect();
    results.push({
        name: formula.name,
        latex: formula.latex,
        correct,
        userAnswer: placedFragments.join(' '),
        correctAnswer: currentFragments.join(' '),
    });
    if (correct) correctCount++;
    else wrongCount++;
    answerRecorded = true;
}

// Reset per-formula bookkeeping (called from loadCurrentFormula).
function resetFormulaState() {
    answerRecorded = false;
    elements.checkBtnNext.disabled = true;
    elements.checkBtn.disabled = false;
}

// Advance to the next formula (button «Дальше», доступна только после
// правильной проверки — поэтому ответ фиксируется как верный).
function checkAnswerNext() {
    recordCurrentResult();
    setTimeout(() => {
        currentFormulaIndex++;
        loadCurrentFormula();
    }, NEXT_FORMULA_DELAY_MS);
}

// Кнопка «Завершить»: зафиксировать текущий ответ (если он ещё не
// записан кнопкой «Дальше») и сразу перейти на последний экран —
// результат теста, пропустив оставшиеся формулы.
function finishTest() {
    recordCurrentResult();
    currentFormulaIndex = formulas.length;
    loadCurrentFormula(); // index >= length → showResults()
}

// ============ RESULTS ============
function computeScore(percentage) {
    if (percentage >= 85) return 5;
    if (percentage >= 65) return 4;
    if (percentage >= 40) return 3;
    return 2;
}

function buildResultsDetailsHtml(resultsList) {
    const iconOk = '<svg class="inline" width="20" height="20" fill="none" stroke="#10b981" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';

    const correct = (resultsList || []).filter(r => r.correct);
    const header = '<h3 class="summary-title">Разбор ответов</h3>'
        + '<p class="detail-note">Показаны только вопросы, на которые был дан правильный ответ</p>';

    if (correct.length === 0) {
        return header + '<p class="detail-note">Нет вопросов, отвеченных правильно</p>';
    }

    return header + '<div class="space-y-3">' + correct.map((r, i) => `
        <div class="result-formula correct">
            <div class="flex items-center gap-2 mb-2">${iconOk}<span class="font-medium">${escapeHtml(r.name)}</span></div>
            <div id="correctFormula${i}" class="p-2"></div>
        </div>`).join('') + '</div>';
}

// Единая итоговая сводка (как в rt_v2 / mt_v2).
function renderResultSummary(data) {
    const box = elements.resultSummary;
    if (!box) return;
    const gradeNames = { 5: 'отлично', 4: 'хорошо', 3: 'удовлетворительно', 2: 'неудовлетворительно' };
    const rows = [
        ['ФИО', (data.fio || '—') + ' Группа: ' + (data.group || '')],
        ['Оценка', `${data.grade} (${gradeNames[data.grade] || '—'}), ${data.percent}% правильных ответов`],
        ['Тема', data.topic || '(не указана в файле)'],
        ['Начало теста', (data.startDateTimeStr || '—') + ' Окончание теста: ' + (data.endTimeStr || '')],
        ['Затраченное время', data.timeSpentStr || '—'],
    ];
    box.innerHTML = rows.map(([label, value]) =>
        `<div class="summary-row"><span class="summary-label">${escapeHtml(label)}:</span>`
        + `<span class="summary-value">${escapeHtml(value)}</span></div>`).join('');
}

function showResults() {
    // Сначала фиксируем время сдачи, затем строим сводку (в ней используется totalTestTime).
    stopTimer();

    const total = formulas.length;
    const percentage = total > 0
        ? Math.max(0, Math.round((correctCount / total - WRONG_ANSWER_PENALTY * wrongCount) * 100))
        : 0;
    const mark = computeScore(percentage);

    const startDateTimeStr = testStartTime > 0 ? formatDateTime(new Date(testStartTime)) : '';
    const endTimeStr = new Date().toLocaleTimeString('ru-RU');

    renderResultSummary({
        fio: studentData.lastName.trim(),
        group: studentData.group.trim(),
        grade: mark,
        percent: percentage,
        topic: quizTitle,
        startDateTimeStr: startDateTimeStr,
        endTimeStr: endTimeStr,
        timeSpentStr: formatClock(totalTestTime)
    });

    lastResult = {
        testTitle: quizTitle || '(не указана в файле)',
        studentName: studentData.lastName.trim(),
        studentGroup: studentData.group.trim(),
        totalQuestions: total,
        correctAnswers: correctCount,
        wrongAnswers: wrongCount,
        percent: percentage,
        grade: mark,
        timeSpentStr: formatClock(totalTestTime),
        startDateTimeStr: startDateTimeStr,
        endTimeStr: endTimeStr,
        saved: false
    };
    initTrackerCard();

    if (resultFormUrl) sendResultsToForm(percentage);

    // Разбор ответов: показаны только правильные ответы (как в rt_v2 / mt_v2).
    elements.resultsDetails.innerHTML = buildResultsDetailsHtml(results);
    results.filter(r => r.correct).forEach((r, i) => {
        const el = document.getElementById(`correctFormula${i}`);
        if (el) renderLatexDisplay(r.latex, el);
    });

    showScreen('result');
}

function sendResultsToForm(percentage) {
    try {
        const params = new URLSearchParams({
            student: `${studentData.lastName} ${studentData.group}`,
            score: `${correctCount}/${formulas.length}`,
            percentage,
            time: formatTime(totalTestTime),
            date: new Date().toLocaleString('ru-RU'),
        });
        fetch(`${resultFormUrl}?${params.toString()}`, { method: 'GET', mode: 'no-cors' })
            .then(() => {
                elements.submissionStatus.style.display = 'inline-flex';
                console.log('Results sent successfully');
            })
            .catch(err => console.error('Error sending results:', err));
    } catch (e) {
        console.error('Error constructing result URL:', e);
    }
}

// ============ Student Tracker: сохранение результата по ИД студента ============
// Интеграция напрямую (как в mt_v2): запросы к Supabase выполняются встроенным
// клиентом, поэтому внешний api.js не нужен.
const SUPABASE_URL = 'https://nfoynqfjkvgtqsgwxves.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5mb3lucWZqa3ZndHFzZ3d4dmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNzc3NDUsImV4cCI6MjEwODk1Mzc0NX0.SR2krMy390zOPeVwUjdBAhufwcj57Kk8VQXqFBu3Fdo';
const TRACKER_STUDENT_PAGE = 'https://tregubovvn.github.io/save_all_result/public/student.html';
const STORAGE_KEY_TRACKER_ID = 'ftStudentTrackerId';

let lastResult = null;

function supabaseHeaders(extra) {
    return Object.assign({
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
    }, extra || {});
}

async function trackerFetchRecords(studentId, limit) {
    let url = `${SUPABASE_URL}/rest/v1/records?student_id=eq.${encodeURIComponent(studentId)}&order=date_time.desc`;
    if (limit) url += `&limit=${limit}`;
    url += `&apikey=${encodeURIComponent(SUPABASE_KEY)}`;
    const resp = await fetch(url, { headers: supabaseHeaders() });
    if (!resp.ok) throw new Error('Ошибка загрузки записей (' + resp.status + ')');
    const json = await resp.json();
    return Array.isArray(json) ? json : [];
}

async function trackerSave(data) {
    if (!data || !data.studentId) throw new Error('Не указан studentId');
    if (!data.activity) throw new Error('Не указано название активности');
    if (data.grade === undefined || data.grade === null || data.grade === '') throw new Error('Не указана оценка');

    const last = await trackerFetchRecords(data.studentId, 1);
    if (last.length) {
        const diffMin = (Date.now() - new Date(last[0].date_time).getTime()) / 60000;
        if (diffMin < 10) {
            throw new Error(`Можно сохранять не чаще раза в 10 минут. Подождите ещё ${Math.ceil(10 - diffMin)} мин.`);
        }
    }

    const record = {
        student_id: String(data.studentId),
        activity: data.activity,
        grade: String(data.grade),
        comment: data.comment || '',
        date_time: new Date().toISOString()
    };
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/records?apikey=${encodeURIComponent(SUPABASE_KEY)}`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify(record)
    });
    if (!(resp.ok || resp.status === 201)) {
        const t = await resp.text().catch(() => '');
        throw new Error('Ошибка сервера: ' + t.slice(0, 120));
    }
    return { success: true, message: 'Запись сохранена', record };
}

function buildTrackerComment(res) {
    const parts = [
        `ФИО: ${res.studentName || '—'}`,
        `Группа: ${res.studentGroup || '—'}`,
        `Тема: ${res.testTitle || '—'}`,
        `Начало теста: ${res.startDateTimeStr || '—'}`,
        `Окончание теста: ${res.endTimeStr || '—'}`,
        `Затраченное время: ${res.timeSpentStr}`,
        `Формул: ${res.totalQuestions}`,
        `Правильных ответов: ${res.correctAnswers}`,
    ];
    return `${parts.join('; ')} Результат: ${res.percent}% (оценка ${res.grade}).`;
}

function setTrackerStatus(message, type) {
    elements.trackerStatus.textContent = message;
    elements.trackerStatus.className = 'tracker-status' + (type ? ' ' + type : '');
    elements.trackerCard.classList.toggle('tracker-ok', type === 'ok');
    elements.trackerCard.classList.toggle('tracker-error', type === 'err');
    if (!message) elements.trackerStatus.classList.add('hidden');
}

function trackerStudentPageUrl(studentId) {
    return `${TRACKER_STUDENT_PAGE}?id=${encodeURIComponent(studentId)}`;
}

function initTrackerCard() {
    elements.trackerCard.classList.remove('tracker-ok', 'tracker-error');
    elements.trackerSaveBtn.disabled = false;
    elements.trackerSaveBtn.textContent = '💾 Сохранить результат';
    let savedId = '';
    try { savedId = localStorage.getItem(STORAGE_KEY_TRACKER_ID) || ''; } catch (e) {}
    if (savedId) elements.trackerStudentIdInput.value = savedId;
    setTrackerStatus('', null);
}

async function saveResultToTracker() {
    if (!lastResult) {
        setTrackerStatus('Нет данных завершённого теста для сохранения.', 'err');
        return;
    }
    const studentId = elements.trackerStudentIdInput.value.trim();
    if (!studentId) {
        setTrackerStatus('Введите ваш ИД (студенческий билет).', 'err');
        elements.trackerStudentIdInput.focus();
        return;
    }

    setTrackerStatus('Сохраняем результат...', 'info');
    elements.trackerSaveBtn.disabled = true;
    elements.trackerSaveBtn.textContent = '⏳ Сохранение...';

    // Вкладку с оценками открываем заранее (браузеры разрешают window.open только
    // из прямого действия), а URL подменяем после успешного сохранения.
    const gradesWindow = window.open('about:blank', '_blank');

    try {
        const result = await trackerSave({
            studentId: studentId,
            activity: 'Formula Test — ' + (lastResult.testTitle || 'тест'),
            grade: String(lastResult.grade),
            comment: buildTrackerComment(lastResult)
        });
        if (result && result.success) {
            lastResult.saved = true;
            try { localStorage.setItem(STORAGE_KEY_TRACKER_ID, studentId); } catch (e) {}
            const gradesUrl = trackerStudentPageUrl(studentId);
            if (gradesWindow) {
                gradesWindow.location.href = gradesUrl;
                setTrackerStatus('✅ Результат сохранён. Все оценки студента открыты в новой вкладке.', 'ok');
                elements.trackerSaveBtn.textContent = '✓ Сохранено';
            } else {
                window.location.href = gradesUrl;
            }
        } else {
            throw new Error(result && result.message ? result.message : 'Сервер отклонил запись');
        }
    } catch (error) {
        if (gradesWindow) gradesWindow.close();
        setTrackerStatus('✗ ' + error.message, 'err');
        elements.trackerSaveBtn.disabled = false;
        elements.trackerSaveBtn.textContent = '💾 Сохранить результат';
    }
}

// ============ QR SCANNER ============
function scanFrameForQr() {
    if (elements.qrVideo.readyState !== elements.qrVideo.HAVE_ENOUGH_DATA) return;
    const canvas = elements.qrCanvas;
    canvas.width = elements.qrVideo.videoWidth;
    canvas.height = elements.qrVideo.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(elements.qrVideo, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if (!code) return;

    elements.qrStatus.textContent = 'QR-код найден!';
    elements.urlInput.value = code.data;
    stopQrScanner();
    loadFromUrl(code.data);
}

async function startQrScanner() {
    elements.qrModal.classList.add('active');
    elements.qrStatus.textContent = 'Запрос разрешения камеры...';
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        elements.qrVideo.srcObject = videoStream;
        await elements.qrVideo.play();
        elements.qrStatus.textContent = 'Наведите камеру на QR-код';
        scanInterval = setInterval(scanFrameForQr, QR_SCAN_INTERVAL_MS);
    } catch (err) {
        elements.qrStatus.textContent = 'Ошибка доступа к камере: ' + err.message;
    }
}

function stopQrScanner() {
    if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
    }
    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
        videoStream = null;
    }
    elements.qrModal.classList.remove('active');
}

// ============ EVENT HANDLERS ============
function bindWelcomeEvents() {
    elements.lastName.addEventListener('input', updateStartButton);
    elements.firstName.addEventListener('input', updateStartButton);

    elements.fileDropZone.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) loadFromFile(e.target.files[0]);
    });
    ['dragenter', 'dragover'].forEach(event => {
        elements.fileDropZone.addEventListener(event, (e) => {
            e.preventDefault();
            elements.fileDropZone.classList.add('drag-over');
        });
    });
    ['dragleave', 'drop'].forEach(event => {
        elements.fileDropZone.addEventListener(event, () => {
            elements.fileDropZone.classList.remove('drag-over');
        });
    });
    elements.fileDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) loadFromFile(e.dataTransfer.files[0]);
    });

    elements.loadUrlBtn.addEventListener('click', () => {
        const url = elements.urlInput.value.trim();
        if (url) loadFromUrl(url);
    });
    elements.scanQrBtn.addEventListener('click', startQrScanner);
    elements.closeQrBtn.addEventListener('click', stopQrScanner);

    elements.startBtn.addEventListener('click', () => {
        studentData.lastName = elements.lastName.value.trim();
        studentData.group = elements.firstName.value.trim();
        elements.studentName.textContent = `${studentData.lastName} ${studentData.group}`;
        currentFormulaIndex = 0;
        correctCount = 0;
        wrongCount = 0;
        results = [];
        startTimer();
        showScreen('main');
        loadCurrentFormula();
    });
}

function bindMainScreenEvents() {
    elements.resetBtn.addEventListener('click', () => {
        renderFragments();
        resetDropZone();
    });
    elements.checkBtn.addEventListener('click', checkAnswer);
    elements.checkBtnNext.addEventListener('click', checkAnswerNext);
    elements.finishBtn.addEventListener('click', finishTest);
}

function bindResultScreenEvents() {
    elements.restartBtn.addEventListener('click', () => {
        showScreen('welcome');
        formulas = [];
        elements.formulasStatus.classList.add('hidden');
        elements.lastName.value = '';
        elements.firstName.value = '';
        elements.urlInput.value = '';
        elements.timerDisplay.textContent = '00:00';
        elements.symbolsContainer.innerHTML = '';
        elements.symbolsContainer.style.display = 'none';
        elements.submissionStatus.style.display = 'none';
        updateStartButton();
    });

    // Student Tracker: сохранение результата по ИД студента (Enter тоже отправляет)
    elements.trackerSaveBtn.addEventListener('click', saveResultToTracker);
    elements.trackerStudentIdInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') saveResultToTracker();
    });
}

// ============ URL PARAMETERS ============
function parseUrlParams() {
    const params = new URLSearchParams(window.location.search);

    const formulaParam = params.get('formula');
    if (formulaParam) {
        formulas.push({
            name: params.get('name') || 'Формула',
            latex: decodeURIComponent(formulaParam),
            symbols: [],
        });
    }

    const fileUrl = params.get('file');
    if (fileUrl) elements.urlInput.value = decodeURIComponent(fileUrl);

    const formUrl = params.get('form_url');
    if (formUrl) resultFormUrl = decodeURIComponent(formUrl);

    return fileUrl ? decodeURIComponent(fileUrl) : null;
}

// ============ INITIALIZATION ============
(function init() {
    bindWelcomeEvents();
    bindMainScreenEvents();
    bindResultScreenEvents();
    bindDropZoneEvents();

    const initialFileUrl = parseUrlParams();
    updateStartButton();
    if (initialFileUrl) loadFromUrl(initialFileUrl);
})();
