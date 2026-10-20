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
let currentFormulaIndex = 0;
let correctCount = 0;
let wrongCount = 0;
let results = [];
let currentFragments = [];
let placedFragments = [];
let studentData = { lastName: '', firstName: '' };
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
    firstName: $('firstName'),
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
    resultStudentName: $('resultStudentName'),
    resultTime: $('resultTime'),
    scoreCircle: $('scoreCircle'),
    scoreValue: $('scoreValue'),
    totalFormulas: $('totalFormulas'),
    correctAnswers: $('correctAnswers'),
    wrongAnswers: $('wrongAnswers'),
    studentResult: $('studentResult'),
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
    timerInterval = setInterval(() => {
        elements.timerDisplay.textContent = formatTime(Date.now() - testStartTime);
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    totalTestTime = Date.now() - testStartTime;
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

function updateCheckButton() {
    elements.checkBtn.disabled = placedFragments.length !== currentFragments.length;
    elements.checkBtnNext.disabled = false;
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

// Live feedback without recording the result (button «Проверить»).
function checkAnswer() {
    const correct = isAnswerCorrect();
    showFeedback(correct);
    elements.checkBtnNext.disabled = !correct;
    elements.checkBtn.disabled = true;
    if (!correct) wrongCount++;
}

// Record the result and advance to the next formula (button «Дальше»).
function checkAnswerNext() {
    const formula = formulas[currentFormulaIndex];
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
    showFeedback(correct);
    setTimeout(() => {
        currentFormulaIndex++;
        loadCurrentFormula();
    }, NEXT_FORMULA_DELAY_MS);
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
    const iconFail = '<svg class="inline" width="20" height="20" fill="none" stroke="#ef4444" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';

    return '<div class="space-y-3">' + resultsList.map((r, i) => `
        <div class="result-formula ${r.correct ? 'correct' : 'incorrect'}">
            <div class="flex items-center gap-2 mb-2">${r.correct ? iconOk : iconFail}<span class="font-medium">${escapeHtml(r.name)}</span></div>
            <p class="text-sm mb-1" style="color: var(--muted)">Правильный ответ:</p>
            <div class="p-2 rounded" style="background: rgba(0,0,0,0.2)"></div>
            <div id="correctFormula${i}" class="p-2"></div>
        </div>`).join('') + '</div>';
}

function showResults() {
    stopTimer();
    const total = formulas.length;
    const percentage = total > 0
        ? Math.max(0, Math.round((correctCount / total - WRONG_ANSWER_PENALTY * wrongCount) * 100))
        : 0;
    const mark = computeScore(percentage);

    elements.resultStudentName.textContent = `${studentData.lastName} ${studentData.firstName}`;
    elements.resultTime.textContent = formatTime(totalTestTime);
    elements.totalFormulas.textContent = total;
    elements.correctAnswers.textContent = correctCount;
    elements.wrongAnswers.textContent = wrongCount;
    elements.studentResult.textContent = mark;
    elements.scoreValue.textContent = `${percentage}%`;
    elements.scoreCircle.style.setProperty('--score', percentage);

    if (resultFormUrl) sendResultsToForm(percentage);

    // Detailed breakdown is shown only when the student passed reasonably well.
    if (percentage > 60) {
        elements.resultsDetails.innerHTML = buildResultsDetailsHtml(results);
        results.forEach((r, i) => {
            const el = document.getElementById(`correctFormula${i}`);
            if (el) renderLatexDisplay(r.latex, el);
        });
    } else {
        elements.resultsDetails.innerHTML = '';
    }

    showScreen('result');
}

function sendResultsToForm(percentage) {
    try {
        const params = new URLSearchParams({
            student: `${studentData.lastName} ${studentData.firstName}`,
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
        studentData.firstName = elements.firstName.value.trim();
        elements.studentName.textContent = `${studentData.lastName} ${studentData.firstName}`;
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
