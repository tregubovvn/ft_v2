'use strict';

/* =========================================================================
   Formula Test Editor — логика приложения
   Архитектура повторяет редактор Moodle XML: XML-панель слева, редактор
   формул справа, настройки в модальном окне. Работает с форматом
   Formula Test XML (<formulas> → <formula name> + <latex> + <symbols>).
   ========================================================================= */

// --- Константы ---
const AUTOSAVE_DEBOUNCE_MS = 1500;      // задержка автосохранения после изменений
const TEST_APP_BASE_URL = 'https://tregubovvn.github.io/ft/index.html';
const GIST_FILENAME = 'formula_test.xml';

// Стартовый шаблон — демонстрация обоих форматов (простой и расширенный)
const DEFAULT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<formulas name="Демонстрационный тест">
  <formula name="Теорема Пифагора">a^2 + b^2 = c^2</formula>
  <formula name="Квадратное уравнение">x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}</formula>
  <formula name="Кинетическая энергия">
    <latex>E_k = \\frac{m v^2}{2}</latex>
    <symbols>
      <symbol char="E_k" name="кинетическая энергия" />
      <symbol char="m" name="масса тела" />
      <symbol char="v" name="скорость тела" />
    </symbols>
  </formula>
</formulas>`;

// Ключи localStorage (gh_token / ds_token / автосохранение — общие с другими редакторами)
const LS = {
    ghToken: 'gh_token',
    dsToken: 'ds_token',
    autoSave: 'editor_autosave_enabled',
    dsMode: 'editor_ds_mode_ft',                // id активного промпта/режима
    promptEdits: 'editor_ds_prompt_edits_ft',   // отредактированные промпты {id: text}
    lastSaveTime: 'editor_last_save_time_ft',   // время последнего сохранения файла на диск
};

// Два ОСНОВНЫХ промпта редактора формул — текст всегда берётся с gist'ов
const BUILTIN_PROMPTS = [
    { id: 'ft-formulas', name: 'Промпт для формул', gistUrl: 'https://gist.github.com/tregubovvn/e32e6561ac50b1866e5cb9de2a238f68' },
    { id: 'ft-tasks', name: 'Промпт для задач', gistUrl: 'https://gist.github.com/tregubovvn/195317d885acce603759b1cdcf6942e4' },
];

// Конец сообщения модели — этим маркером модель подтверждает, что XML готов
const READY_MARKER = '[FORMULA-XML-READY]';

// --- Состояние ---
const state = {
    formData: { name: '', formulas: [] },    // name — название теста (в описание GIST)
    currentFormulaIndex: 0,
    gistId: null,
    gistUrl: null,
    rawUrl: null,
    gistFilename: GIST_FILENAME,
    dirty: false,               // есть несохранённые изменения в задании (файл на диске)
    isSaving: false,            // идёт запись в GIST
    needsAnotherSave: false,
    syncTimeout: null,
    gistSaveTimeout: null,
    autoSaveTimeout: null,
    previewTimeout: null,
    fileHandle: null,           // FileSystemFileHandle выбранного файла на диске
    loadedFileName: null,       // имя загруженного с диска файла
    aiBusy: false,              // идёт запрос к DeepSeek (интерфейс заблокирован)
    // Промпты DeepSeek: [{id, name, text, source:'gist'|'local', gistUrl?}]
    prompts: [],
    // Флаг «изменение идёт из XML-панели» — не пересинхронизировать редактор -> XML
    applyingXmlToEditor: false,
    // Последнее активное поле ввода в редакторе — туда вставляются LaTeX-конструкции
    lastFocusedInput: null,
};

let els = {};                   // кэш ссылок на DOM-элементы

// --- Инициализация ---
document.addEventListener('DOMContentLoaded', () => {
    cacheElements();
    loadSettings();
    parseXmlToData(DEFAULT_XML);
    renderAll();
    updateXmlOutput({ immediate: true, silent: true });
    renderModeSelect();
    updateLastSaveTimeLabel();
    initResizer();
    bindEvents();
    loadPromptsFromGists();   // подтягиваем основные промпты из Gist
});

// Отладочный доступ к состоянию и ключевым функциям из консоли браузера.
Object.defineProperty(window, 'editorState', {
    get: () => ({
        state,
        api: {
            publishToGist, saveToFile, loadFromDiskFile, askDeepSeek, setDsMode, currentDsMode,
            generateXml, parseXmlToData, loadPromptsFromGists, buildDsPrompt,
            openTask, copyTaskUrl, reloadActivePromptFromGist, savePromptEdit,
            addLocalPrompt, removePrompt, newQuiz,
        },
        fn: {
            updateLastSaveTimeLabel, recordDiskSave, setUiBusy, buildDsMessage, getPromptById,
            renderReviewPanel, findFormulaIssues, buildTaskUrl, parseLatexToFragments,
        },
    }),
});

function cacheElements() {
    const ids = [
        'quizName', 'xmlEditor', 'xmlPanel', 'resizer', 'editorContainer',
        'formulaCard', 'formulaNumber', 'formulaName', 'formulaLatex', 'fxBar', 'issuesBox',
        'fragmentsPreview', 'fragmentsCount', 'symbolsContainer', 'btnAddSymbol',
        'previewBox', 'formulaTabs', 'prevBtn', 'nextBtn',
        'statusText', 'statusMeta', 'toast', 'gistLinkContainer', 'publishedTaskLink',
        'loadModal', 'loadGistId', 'settingsModal', 'publishMenu', 'promptBar', 'promptText', 'publishCheckNote',
        'reviewPanel', 'reviewBody', 'reviewSummary', 'btnToggleReview',
        'dsModeSelect', 'btnManagePrompts', 'btnEditPrompt', 'btnCopyPrompt', 'btnReloadPrompt',
        'promptGistLink', 'lastSaveTimeLabel',
        'promptsModal', 'promptList', 'newPromptName', 'btnAddPrompt',
        'btnReloadPrompts',
        'promptEditorModal', 'promptEditorArea', 'promptEditorInfo',
    ];
    els = {};
    ids.forEach(id => { els[id] = document.getElementById(id); });
    // Окно результата DeepSeek (когда ответ пришёл НЕ в виде XML) создаём динамически
    if (!document.getElementById('dsResultModal')) buildDsResultWindow();
    // Элементы вне стандартного списка
    els.autoSaveToggle = document.getElementById('autoSaveToggle');
}

function bindEvents() {
    // Верхняя панель
    on('btnNewQuiz', 'click', newQuiz);
    on('btnPublishGist', 'click', () => { hidePublishMenu(); publishToGist(); });
    on('btnLoadGist', 'click', showLoadModal);
    on('btnLoadDiskFile', 'click', loadFromDiskFile);
    on('btnSaveFile', 'click', saveToFile);
    on('btnPublish', 'click', (e) => { e.stopPropagation(); togglePublishMenu(); });
    on('btnSettings', 'click', showSettingsModal);
    on('btnCopyXml', 'click', copyXml);
    on('btnApplyXml', 'click', applyXmlChanges);
    on('btnAskDeepSeek', 'click', () => askDeepSeek(currentDsMode()));

    // Ссылка на задание — в строке названия (над навигацией по формулам)
    on('btnCopyTaskUrl', 'click', copyTaskUrl);
    on('btnOpenTaskTop', 'click', openTask);

    // Правая панель обзора формул
    els.btnToggleReview.addEventListener('click', toggleReviewPanel);
    on('btnReviewClose', 'click', hideReviewPanel);

    // Панель промпта под окном XML
    els.dsModeSelect.addEventListener('change', () => setDsMode(els.dsModeSelect.value));
    on('btnManagePrompts', 'click', showPromptsModal);
    on('btnEditPrompt', 'click', openPromptEditor);
    on('btnCopyPrompt', 'click', () => copyPrompt(currentDsMode()));
    on('btnReloadPrompt', 'click', reloadActivePromptFromGist);

    // Окно «Промпты DeepSeek»
    on('btnPromptsClose', 'click', hidePromptsModal);
    on('btnPromptsDone', 'click', hidePromptsModal);
    els.promptsModal.addEventListener('click', (e) => { if (e.target === els.promptsModal) hidePromptsModal(); });
    on('btnAddPrompt', 'click', addLocalPrompt);
    on('btnReloadPrompts', 'click', reloadAllPromptsFromGist);

    // Модальное окно текстового редактора активного промпта
    on('btnPromptEditorClose', 'click', hidePromptEditor);
    on('btnPromptEditorCancel', 'click', hidePromptEditor);
    on('btnPromptEditorSave', 'click', savePromptFromEditor);
    els.promptEditorModal.addEventListener('click', (e) => { if (e.target === els.promptEditorModal) hidePromptEditor(); });

    // Редактор формулы
    els.formulaName.addEventListener('input', () => {
        currentFormula().name = els.formulaName.value;
        updateNavigation();
        updateXmlOutput();
    });
    els.formulaLatex.addEventListener('input', () => {
        currentFormula().latex = els.formulaLatex.value;
        schedulePreview();
        updateNavigation();
        updateXmlOutput();
    });
    els.quizName.addEventListener('input', () => {
        state.formData.name = els.quizName.value;
        updateXmlOutput();
    });
    on('prevBtn', 'click', prevFormula);
    on('nextBtn', 'click', nextFormula);
    on('btnAddFormula', 'click', addFormula);
    on('btnDuplicateFormula', 'click', duplicateFormula);
    on('btnDeleteFormula', 'click', deleteCurrentFormula);
    on('btnAddSymbol', 'click', addSymbol);

    // Панель вставки LaTeX: вставка в последнее активное поле
    els.fxBar.querySelectorAll('.fx-btn').forEach(btn => {
        btn.addEventListener('click', () => ins(btn.dataset.before || '', btn.dataset.after || ''));
    });

    // Запоминаем последнее активное поле ввода — туда вставляются конструкции
    document.addEventListener('focusin', (e) => {
        if (e.target.closest && e.target.closest('.editor-scroll-container') &&
            (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
            state.lastFocusedInput = e.target;
        }
    });

    // XML-панель (ручное редактирование): парсим «тихо», помечаем изменения
    els.xmlEditor.addEventListener('input', () => {
        if (state.applyingXmlToEditor) return;
        silentParseXml(els.xmlEditor.value);
        updatePublishReadiness();
        if (!els.reviewPanel.classList.contains('hidden')) renderReviewPanel();
        markTaskChanged();
    });

    // Модальные окна
    on('btnLoadCancel', 'click', hideLoadModal);
    on('btnLoadConfirm', 'click', loadFromGist);
    els.loadModal.addEventListener('click', (e) => { if (e.target === els.loadModal) hideLoadModal(); });
    on('btnSettingsClose', 'click', hideSettingsModal);
    on('btnSettingsDone', 'click', hideSettingsModal);
    els.settingsModal.addEventListener('click', (e) => { if (e.target === els.settingsModal) hideSettingsModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideLoadModal(); hideSettingsModal(); hidePromptsModal(); hidePromptEditor(); hidePublishMenu();
        }
    });

    // Поля настроек (токены) + переключатель автосохранения
    ['githubToken', 'deepseekToken'].forEach(id => {
        document.getElementById(id).addEventListener('change', saveSettings);
    });
    els.autoSaveToggle.addEventListener('change', () => {
        saveSettings();
        setStatus(autoSaveEnabled() ? 'Автосохранение на диск включено' : 'Автосохранение выключено');
    });

    // Меню публикации — закрытие по клику вне кнопок и самого меню
    document.addEventListener('click', (e) => {
        if (e.target.closest('#btnPublish') || e.target.closest('.publish-menu')) return;
        hidePublishMenu();
    });
}

// Делегирование событий для динамически создаваемых условных обозначений
document.addEventListener('input', (e) => {
    const t = e.target;
    const action = t.dataset && t.dataset.action;
    if (!action) return;
    if (action === 'update-symbol') {
        const i = +t.dataset.i;
        const field = t.dataset.field;
        const f = currentFormula();
        if (!f || !f.symbols[i]) return;
        f.symbols[i][field] = t.value;
        // Рендер-чип обновляем точечно — полная перерисовка сбросила бы фокус
        if (field === 'char') {
            const chip = t.closest('.symbol-row') && t.closest('.symbol-row').querySelector('.sym-render');
            if (chip) chip.innerHTML = renderLatexInline(t.value);
        }
        updateXmlOutput({ force: true });
    }
});

document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    const f = state.formData.formulas[state.currentFormulaIndex];
    if (!f) return;

    if (action === 'remove-symbol') {
        f.symbols.splice(+t.dataset.i, 1);
        renderSymbols(f);
        updateXmlOutput();
    }
});

// Флаг state.applyingXmlToEditor: пока идёт применение XML к редактору,
// слушатель input на XML-панели не перепарсит её содержимое повторно.
function withApplyingXml(fn) {
    state.applyingXmlToEditor = true;
    try { return fn(); } finally { state.applyingXmlToEditor = false; }
}

function on(id, ev, fn) { document.getElementById(id).addEventListener(ev, fn); }

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
function escAttr(str) {
    return escHtml(str).replace(/"/g, '&quot;');
}

function currentFormula() {
    return state.formData.formulas[state.currentFormulaIndex];
}

// ============================================================
// Настройки (токены, автосохранение) — в localStorage
// ============================================================
function loadSettings() {
    document.getElementById('githubToken').value = localStorage.getItem(LS.ghToken) || '';
    document.getElementById('deepseekToken').value = localStorage.getItem(LS.dsToken) || '';
    els.autoSaveToggle.checked = localStorage.getItem(LS.autoSave) === '1';
}

function saveSettings() {
    localStorage.setItem(LS.ghToken, document.getElementById('githubToken').value.trim());
    localStorage.setItem(LS.dsToken, document.getElementById('deepseekToken').value.trim());
    localStorage.setItem(LS.autoSave, els.autoSaveToggle.checked ? '1' : '0');
}

function getGithubToken() { return document.getElementById('githubToken').value.trim(); }
function getDeepseekToken() { return document.getElementById('deepseekToken').value.trim(); }
function autoSaveEnabled() { return els.autoSaveToggle.checked; }

// Активный режим DeepSeek = id промпта из state.prompts
function currentDsMode() { return localStorage.getItem(LS.dsMode) || 'ft-formulas'; }
function setDsMode(mode) {
    localStorage.setItem(LS.dsMode, mode);
    renderModeSelect();
}

// Наполнение выпадающего списка режимов и показ текста активного промпта
function renderModeSelect() {
    const activeId = currentDsMode();
    if (els.dsModeSelect) {
        els.dsModeSelect.innerHTML = state.prompts
            .map(p => `<option value="${escHtml(p.id)}"${p.id === activeId ? ' selected' : ''}>${escHtml(p.name)}</option>`)
            .join('');
        if (state.prompts.length && !state.prompts.some(p => p.id === activeId)) {
            els.dsModeSelect.selectedIndex = 0;
            localStorage.setItem(LS.dsMode, state.prompts[0].id);
        }
    }
    const prompt = getPromptById(currentDsMode()) || state.prompts[0];
    if (document.activeElement !== els.promptText) {
        els.promptText.value = prompt ? prompt.text : '';
    }
    updatePromptGistLink();
}

function getPromptById(id) {
    return state.prompts.find(p => p.id === id) || null;
}

// Сохранение отредактированного промпта (правки живут в localStorage)
function savePromptEdit(text) {
    const id = currentDsMode();
    const p = getPromptById(id);
    if (!p) return;
    p.text = text;
    try {
        const edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}');
        edits[id] = text;
        localStorage.setItem(LS.promptEdits, JSON.stringify(edits));
    } catch (e) { /* повреждённые данные — пропускаем */ }
}

// Кнопка «↻ Gist» — перезагрузить активный промпт из его Gist
async function reloadActivePromptFromGist() {
    const p = getPromptById(currentDsMode());
    if (!p || p.source !== 'gist') {
        showToast('Этот промпт локальный — перезагрузка из Gist недоступна', true);
        return;
    }
    await loadPromptsFromGists({ only: p.id });
    setStatus('Промпт обновлён из Gist');
    showToast('Промпт «' + p.name + '» обновлён из Gist (правки отменены)');
}

// Ссылка на Gist активного основного промпта (под окном XML)
function updatePromptGistLink() {
    const link = els.promptGistLink;
    if (!link) return;
    const p = getPromptById(currentDsMode());
    if (p && p.gistUrl) {
        link.href = p.gistUrl;
        link.textContent = 'Промпт на Gist ↗';
        link.classList.remove('hidden');
    } else {
        link.classList.add('hidden');
    }
}

// Полное сообщение для DeepSeek: активный промпт + XML из панели
function buildDsMessage(mode) {
    const p = getPromptById(mode) || state.prompts[0];
    const xml = els.xmlEditor.value || generateXml();
    return buildDsPrompt(p ? p.text : '') + '\n\nXML-ЗАДАНИЕ:\n' + xml;
}

// ============================================================
// Промпты DeepSeek: основные — из Gist, свои — локально
// ============================================================
async function fetchGistRaw(url) {
    const m = url.match(/(?:gist\.github\.com|gist\.githubusercontent\.com)\/(?:[^/\s]+\/)?([0-9a-f]{7,})/i);
    if (!m) throw new Error('Некорректная ссылка на Gist: ' + url);
    const res = await fetch('https://api.github.com/gists/' + m[1]);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' при загрузке Gist');
    const data = await res.json();
    const files = Object.values(data.files || {});
    if (!files.length) throw new Error('В Gist нет файлов');
    const preferred = files.find(f => /\.(md|txt)$/i.test(f.filename)) || files[0];
    const rawRes = await fetch(preferred.raw_url);
    if (!rawRes.ok) throw new Error('HTTP ' + rawRes.status + ' при чтении файла Gist');
    return await rawRes.text();
}

// Загрузка основных промптов из Gist; локальные промпты и правки сохраняются.
// opts.only — обновить только промпт с этим id.
async function loadPromptsFromGists(opts = {}) {
    setStatus('Загрузка промптов с GitHub Gist…');
    let edits = {};
    try { edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}'); } catch (e) { edits = {}; }

    const localPrompts = state.prompts.filter(p => p.source === 'local');

    const builtins = await Promise.all(BUILTIN_PROMPTS.map(async (b) => {
        let text = '';
        try { text = (await fetchGistRaw(b.gistUrl)).trim(); }
        catch (e) { console.warn('Не удалось загрузить промпт «' + b.name + '»:', e); }
        return { id: b.id, name: b.name, text, source: 'gist', gistUrl: b.gistUrl };
    }));

    if (opts.only) {
        const fresh = builtins.find(p => p.id === opts.only);
        if (fresh) {
            const existing = getPromptById(opts.only);
            if (existing) {
                existing.text = fresh.text || existing.text;
                existing.name = fresh.name;
                existing.source = 'gist';
                existing.gistUrl = fresh.gistUrl;
            } else {
                state.prompts.push(fresh);
            }
            delete edits[opts.only];
            localStorage.setItem(LS.promptEdits, JSON.stringify(edits));
        }
    } else {
        // Основные промпты всегда присутствуют (даже с пустым текстом —
        // режим виден и его можно перезагрузить кнопкой «↻ Gist»)
        const known = state.prompts.filter(p => !BUILTIN_PROMPTS.some(b => b.id === p.id) && p.source !== 'local');
        state.prompts = [...builtins, ...known, ...localPrompts];
    }

    // Восстанавливаем локальные правки поверх загруженных текстов
    for (const p of state.prompts) {
        if (typeof edits[p.id] === 'string' && edits[p.id].trim()) p.text = edits[p.id];
    }

    renderModeSelect();
    if (els.promptsModal.classList.contains('show')) renderPromptList();
    const okCount = state.prompts.filter(p => p.text).length;
    if (okCount === state.prompts.length && okCount > 0) setStatus('Готово: ' + okCount + ' промпт(ов) загружено из Gist');
    else if (okCount > 0) setStatus('Готово: ' + okCount + ' из ' + state.prompts.length + ' промптов имеют текст («↻ Gist» или редактор промпта)');
    else setStatus('Промпты с Gist не загрузились — нажмите «↻ Gist» или отредактируйте промпт вручную');
}

// Перезагрузка всех основных промптов из Gist (кнопка в окне «Промпты…»)
async function reloadAllPromptsFromGist() {
    localStorage.setItem(LS.promptEdits, '{}');   // отменяем локальные правки текстов
    await loadPromptsFromGists();
    renderPromptList();
    showToast('Основные промпты перезагружены из Gist');
}

// --- Окно «Промпты DeepSeek» ------------------------------------------------
function showPromptsModal() {
    renderPromptList();
    els.promptsModal.classList.add('show');
}
function hidePromptsModal() {
    els.promptsModal.classList.remove('show');
    renderModeSelect();
}

function renderPromptList() {
    els.promptList.innerHTML = state.prompts.map(p => `
        <li class="prompt-item${p.id === currentDsMode() ? ' active' : ''}" data-id="${escHtml(p.id)}">
            <div class="prompt-item-main">
                <span class="prompt-item-name">${p.source === 'gist' ? '☁' : '📝'} ${escHtml(p.name)}</span>
                <span class="prompt-item-meta">${p.source === 'gist' ? 'из Gist' : 'локальный'} · ${(p.text || '').length} симв.</span>
            </div>
            <div class="prompt-item-actions">
                <button type="button" class="btn btn-sm btn-ghost" data-action="edit" title="Открыть в текстовом редакторе">✎</button>
                ${p.source === 'local' ? '<button type="button" class="btn btn-sm btn-ghost" data-action="remove" title="Удалить локальный промпт">✕</button>' : ''}
            </div>
        </li>`).join('') || '<li class="hint">Промпты не загружены — «↻ Загрузить из Gist».</li>';

    els.promptList.querySelectorAll('.prompt-item').forEach(li => {
        const id = li.dataset.id;
        li.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]') && e.target.closest('[data-action]').dataset.action;
            if (action === 'edit') { setDsMode(id); openPromptEditor(); return; }
            if (action === 'remove') { removePrompt(id); return; }
            setDsMode(id);          // выбор режима кликом по строке
            renderPromptList();
        });
    });
}

// Добавление своего (локального) промпта
function addLocalPrompt() {
    const name = els.newPromptName.value.trim();
    if (!name) { showToast('Введите название промпта', true); return; }
    let id = promptIdFromTitle(name);
    if (getPromptById(id)) id = id + '-' + Date.now().toString(36);
    state.prompts.push({ id, name, text: '', source: 'local' });
    els.newPromptName.value = '';
    setDsMode(id);
    renderPromptList();
    openPromptEditor();   // сразу предлагаем написать текст
    showToast('Промпт «' + name + '» добавлен. Напишите его текст и сохраните.');
}

// Стабильный id промпта по названию (кириллица разрешена)
function promptIdFromTitle(title) {
    const slug = (title || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return slug || ('prompt-' + Math.random().toString(36).slice(2, 8));
}

function removePrompt(id) {
    const idx = state.prompts.findIndex(p => p.id === id);
    if (idx === -1) return;
    const [removed] = state.prompts.splice(idx, 1);
    const edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}');
    delete edits[id];
    localStorage.setItem(LS.promptEdits, JSON.stringify(edits));
    if (currentDsMode() === id) setDsMode(state.prompts[0] ? state.prompts[0].id : 'ft-formulas');
    renderPromptList();
    renderModeSelect();
    showToast('Промпт «' + removed.name + '» удалён');
}

// --- Модальное окно текстового редактора активного промпта ------------------
function openPromptEditor() {
    const p = getPromptById(currentDsMode());
    if (!p) { showToast('Сначала выберите или добавьте промпт', true); return; }
    els.promptEditorArea.value = p.text || '';
    els.promptEditorInfo.textContent =
        'Промпт: «' + p.name + '» (' + (p.source === 'gist' ? 'из Gist' : 'локальный') + '). ' +
        'Правка сохраняется в браузере; «↻ Gist» отменяет правки основных промптов.';
    els.promptEditorModal.classList.add('show');
    els.promptEditorArea.focus();
}
function hidePromptEditor() { els.promptEditorModal.classList.remove('show'); }

function savePromptFromEditor() {
    savePromptEdit(els.promptEditorArea.value);
    renderModeSelect();
    if (els.promptsModal.classList.contains('show')) renderPromptList();
    hidePromptEditor();
    showToast('Промпт сохранён (локально)');
}

// Кнопка «📋 Копировать» — копирует активный промпт в буфер обмена
async function copyPrompt(mode) {
    const p = getPromptById(mode) || state.prompts[0];
    try {
        await navigator.clipboard.writeText(p ? p.text : '');
        showToast('Промпт скопирован в буфер обмена');
    } catch (e) {
        showToast('Не удалось скопировать промпт', true);
    }
}

// Добавляем к промпту технические требования к формату ответа
function buildDsPrompt(basePrompt) {
    return (basePrompt || '').trim() + '\n\n' +
        'ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ К ОТВЕТУ:\n' +
        '1. Входные данные — XML-файл задания Formula Test (приведён после этого промпта).\n' +
        '2. Ответь ТОЛЬКО полным готовым XML (<formulas ...>...</formulas>) без пояснений и без блоков markdown.\n' +
        '3. Сохрани структуру: корень <formulas name="...">, формулы <formula name="...">latex</formula> ' +
        'или расширенный формат с <latex> и <symbols> (<symbol char="..." name="..."/>).\n' +
        '4. Последней строкой ответа добавь точный маркер: ' + READY_MARKER;
}


// ============================================================
// XML: парсинг и генерация (формат Formula Test)
// ============================================================
// «Тихий» парсинг XML в состояние (без toast и без перерисовки редактора)
function silentParseXml(xmlString) {
    return withApplyingXml(() => parseXmlToDataQuiet(xmlString));
}

function parseXmlToData(xmlString) {
    const ok = parseXmlToDataQuiet(xmlString);
    if (!ok) showToast('Некорректный XML (нет формул)', true);
    return ok;
}

function parseXmlToDataQuiet(xmlString) {
    try {
        const doc = new DOMParser().parseFromString(xmlString || '<formulas/>', 'text/xml');
        if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

        const root = doc.documentElement;
        if (!root || root.nodeName !== 'formulas') throw new Error('no <formulas> root');

        state.formData.name = root.getAttribute('name') || '';
        els.quizName.value = state.formData.name;

        const fs = [];
        doc.querySelectorAll('formula').forEach(f => {
            const latexNode = f.querySelector('latex');
            const latex = latexNode ? latexNode.textContent.trim() : f.textContent.trim();
            const symbols = [];
            f.querySelectorAll('symbol').forEach(s => {
                symbols.push({ char: s.getAttribute('char') || '', name: s.getAttribute('name') || '' });
            });
            fs.push({ name: f.getAttribute('name') || '', latex, symbols });
        });

        if (!fs.length) throw new Error('no formulas');

        state.formData.formulas = fs;
        if (state.currentFormulaIndex >= fs.length) state.currentFormulaIndex = 0;
        return true;
    } catch (e) {
        return false;   // сообщение показывает вызвавший (parseXmlToData) или «тихий» режим
    }
}

function generateXml() {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<formulas name="' + escapeXml(state.formData.name || '') + '">\n';
    state.formData.formulas.forEach(f => {
        const symbols = (f.symbols || []).filter(s => (s.char && s.char.trim()) || (s.name && s.name.trim()));
        if (symbols.length > 0) {
            // Расширенный формат (с условными обозначениями)
            xml += '  <formula name="' + escapeXml(f.name) + '">\n';
            xml += '    <latex>' + escapeXml(f.latex) + '</latex>\n';
            xml += '    <symbols>\n';
            symbols.forEach(s => {
                xml += '      <symbol char="' + escapeXml(s.char) + '" name="' + escapeXml(s.name) + '" />\n';
            });
            xml += '    </symbols>\n';
            xml += '  </formula>\n';
        } else {
            // Простой формат
            xml += '  <formula name="' + escapeXml(f.name) + '">' + escapeXml(f.latex) + '</formula>\n';
        }
    });
    xml += '</formulas>';
    return xml;
}

function escapeXml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function newFormulaItem() {
    return { name: '', latex: '', symbols: [] };
}

// ============================================================
// Разбор LaTeX на фрагменты вынесен в общий модуль js/latex-fragments.js
// (тот же файл используется приложением Formula Builder — алгоритмы не
// расходятся). Функция parseLatexToFragments доступна как глобальная.
// ============================================================

// ============================================================
// Рендеринг редактора формул
// ============================================================
function renderAll() {
    renderFormula();
    updateGistLinkDisplay();
    updatePublishReadiness();
}

function renderLatexInline(latex) {
    if (!window.katex) return escHtml(latex);
    try { return katex.renderToString(latex, { throwOnError: false }); } catch (e) { return escHtml(latex); }
}

function renderFormula() {
    if (!state.formData.formulas.length) state.formData.formulas.push(newFormulaItem());
    if (state.currentFormulaIndex >= state.formData.formulas.length) {
        state.currentFormulaIndex = state.formData.formulas.length - 1;
    }
    const f = state.formData.formulas[state.currentFormulaIndex];

    els.formulaNumber.textContent = state.currentFormulaIndex + 1;
    els.formulaName.value = f.name;
    els.formulaLatex.value = f.latex;

    renderPreview(f);
    renderFragmentsPreview(f);
    renderIssues(f, true);
    renderSymbols(f);
    updateNavigation();
}

function renderPreview(f) {
    const box = els.previewBox;
    if (!f.latex.trim()) {
        box.className = 'preview-box';
        box.innerHTML = '<span class="hint">Введите LaTeX, чтобы увидеть формулу</span>';
        return;
    }
    if (!window.katex) {
        box.className = 'preview-box';
        box.textContent = f.latex;
        return;
    }
    try {
        katex.render(f.latex, box, { throwOnError: true, displayMode: true });
        box.className = 'preview-box';
    } catch (e) {
        box.className = 'preview-box error';
        box.innerHTML = '<div><div class="err-title">Ошибка LaTeX</div>' + escHtml(e.message) + '</div>';
    }
}

function renderFragmentsPreview(f) {
    const container = els.fragmentsPreview;
    const count = els.fragmentsCount;
    if (!f.latex.trim()) {
        count.textContent = '0';
        container.innerHTML = '<span class="hint">Фрагменты появятся после ввода LaTeX</span>';
        return;
    }
    const frags = parseLatexToFragments(f.latex);
    count.textContent = String(frags.length);
    if (!frags.length) {
        container.innerHTML = '<span class="hint">Не удалось разбить формулу на фрагменты</span>';
        return;
    }
    container.innerHTML = frags.map((fr, i) =>
        '<span class="frag-chip"><span class="frag-num">' + (i + 1) + '</span>' + renderLatexInline(fr) + '</span>'
    ).join('');
}

function computeIssues(f, deep) {
    const issues = [];
    if (!f.name.trim()) issues.push('не задано название формулы');
    if (!f.latex.trim()) { issues.push('не задан LaTeX'); return issues; }
    if (deep && window.katex) {
        try { katex.renderToString(f.latex, { throwOnError: true, displayMode: true }); }
        catch (e) { issues.push('ошибка KaTeX: ' + e.message); }
    }
    const frags = parseLatexToFragments(f.latex);
    if (frags.length < 2) issues.push('формула разбивается менее чем на 2 фрагмента');
    if (new Set(frags).size < frags.length) issues.push('есть одинаковые фрагменты — порядок сборки может быть неоднозначным');
    return issues;
}

function renderIssues(f, deep) {
    const box = els.issuesBox;
    const issues = computeIssues(f, deep);
    if (!issues.length) {
        box.className = 'issues-box ok';
        box.textContent = '✓ Формула готова к тесту';
    } else {
        box.className = 'issues-box warn';
        box.innerHTML = 'Требуют внимания:<ul>' + issues.map(i => '<li>' + escHtml(i) + '</li>').join('') + '</ul>';
    }
}

function renderSymbols(f) {
    const container = els.symbolsContainer;
    if (!f.symbols.length) {
        container.innerHTML = '<div class="hint" style="padding: 0.25rem 0;">Обозначения не заданы. Они показываются студенту как подсказка перед сборкой формулы.</div>';
        return;
    }
    container.innerHTML = f.symbols.map((s, i) => `
        <div class="symbol-row">
            <input type="text" class="input-base sym-char" value="${escAttr(s.char)}" data-action="update-symbol" data-i="${i}" data-field="char" placeholder="E_k">
            <div class="sym-render">${renderLatexInline(s.char)}</div>
            <span class="symbol-dash">—</span>
            <input type="text" class="input-base sym-name" value="${escAttr(s.name)}" data-action="update-symbol" data-i="${i}" data-field="name" placeholder="расшифровка">
            <button type="button" class="btn-icon" data-action="remove-symbol" data-i="${i}" title="Удалить обозначение">&#10005;</button>
        </div>
    `).join('');
}

function updateNavigation() {
    els.prevBtn.disabled = state.currentFormulaIndex === 0;
    els.nextBtn.disabled = state.currentFormulaIndex >= state.formData.formulas.length - 1;
    els.formulaTabs.innerHTML = state.formData.formulas.map((f, i) => {
        const hasIssues = computeIssues(f, false).length > 0;
        return `<button type="button" class="nav-btn ${i === state.currentFormulaIndex ? 'active' : ''}" data-q="${i}" title="${escAttr(f.name || 'Формула ' + (i + 1))}">${i + 1}${hasIssues ? '<span class="tab-dot"></span>' : ''}</button>`;
    }).join('');
    els.formulaTabs.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => goToFormula(+b.dataset.q));
    });
    els.statusMeta.textContent = 'Формул: ' + state.formData.formulas.length;
}

function schedulePreview() {
    clearTimeout(state.previewTimeout);
    state.previewTimeout = setTimeout(() => {
        const f = currentFormula();
        renderPreview(f);
        renderFragmentsPreview(f);
        renderIssues(f, true);
    }, 300);
}

// ============================================================
// Действия редактора
// ============================================================
function newQuiz() {
    if (state.dirty && !confirm('В текущем задании есть изменения. Создать новое задание без сохранения?')) return;
    parseXmlToData(DEFAULT_XML);
    state.currentFormulaIndex = 0;
    renderFormula();
    updateXmlOutput({ immediate: true, silent: true });
    setStatus('Создано новое задание из шаблона');
    showToast('Создано новое задание из шаблона');
}

function addFormula() {
    state.formData.formulas.push(newFormulaItem());
    state.currentFormulaIndex = state.formData.formulas.length - 1;
    renderFormula();
    updateXmlOutput();
    els.formulaName.focus();
}

function duplicateFormula() {
    const copy = JSON.parse(JSON.stringify(currentFormula()));
    state.formData.formulas.splice(state.currentFormulaIndex + 1, 0, copy);
    state.currentFormulaIndex++;
    renderFormula();
    updateXmlOutput();
    showToast('Формула продублирована');
}

function deleteCurrentFormula() {
    if (state.formData.formulas.length <= 1) return showToast('Нельзя удалить последнюю формулу', true);
    const f = currentFormula();
    if (!confirm('Удалить формулу "' + (f.name || (state.currentFormulaIndex + 1)) + '"?')) return;
    state.formData.formulas.splice(state.currentFormulaIndex, 1);
    state.currentFormulaIndex = Math.min(state.currentFormulaIndex, state.formData.formulas.length - 1);
    renderFormula();
    updateXmlOutput();
}

function prevFormula() { if (state.currentFormulaIndex > 0) { state.currentFormulaIndex--; renderFormula(); } }
function nextFormula() { if (state.currentFormulaIndex < state.formData.formulas.length - 1) { state.currentFormulaIndex++; renderFormula(); } }
function goToFormula(i) { state.currentFormulaIndex = i; renderFormula(); }

function addSymbol() {
    currentFormula().symbols.push({ char: '', name: '' });
    renderSymbols(currentFormula());
    updateXmlOutput();
    const rows = els.symbolsContainer.querySelectorAll('.sym-char');
    if (rows.length) rows[rows.length - 1].focus();
}

// ===== ВСТАВКА LaTeX-КОНСТРУКЦИЙ =====
function ins(before, after) {
    const el = state.lastFocusedInput;
    if (!el || !el.isConnected) return showToast('Сначала щёлкните в поле LaTeX, названия или обозначения', true);
    const s = el.selectionStart ?? el.value.length;
    const e2 = el.selectionEnd ?? s;
    const sel = el.value.substring(s, e2);
    el.value = el.value.slice(0, s) + before + sel + after + el.value.slice(e2);
    el.focus();
    const pos = s + before.length + sel.length;
    el.selectionStart = el.selectionEnd = pos;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}


// ============================================================
// Синхронизация данных -> XML-панель + автосохранение (диск + Gist).
// Автосохранение срабатывает ТОЛЬКО при изменениях в задании — см. markTaskChanged().
// ============================================================
function updateXmlOutput(opts = {}) {
    clearTimeout(state.syncTimeout);
    const sync = () => {
        // Пока пользователь редактирует XML-панель — не перезаписываем её содержимое
        if (document.activeElement === els.xmlEditor && !opts.force) return;
        els.xmlEditor.value = generateXml();
    };
    if (opts.immediate || opts.force) sync();
    else state.syncTimeout = setTimeout(sync, 100);

    // Индикатор готовности к публикации + панель обзора (если открыта)
    updatePublishReadiness();
    if (!els.reviewPanel.classList.contains('hidden')) renderReviewPanel();

    // Изменение В ЗАДАНИИ: помечаем как несохранённое и запускаем автосохранение
    if (!opts.silent) markTaskChanged();
}

// Единственная точка «в задании есть изменения»: dirty + автосохранения
function markTaskChanged() {
    state.dirty = true;
    scheduleAutoSave();
    scheduleGistSave();
}

// Подпись под переключателем «Автосохранение»: время последнего сохранения на диск
function updateLastSaveTimeLabel() {
    const label = els.lastSaveTimeLabel;
    if (!label) return;
    const ts = parseInt(localStorage.getItem(LS.lastSaveTime) || '0', 10);
    if (ts) {
        const d = new Date(ts);
        label.textContent = 'Последнее сохранение: ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
        label.classList.remove('hidden');
    } else {
        label.textContent = '';
        label.classList.add('hidden');
    }
}

// Фиксация факта успешного сохранения на диск (ручное или автосохранение)
function recordDiskSave() {
    localStorage.setItem(LS.lastSaveTime, String(Date.now()));
    updateLastSaveTimeLabel();
}

function scheduleAutoSave() {
    if (!autoSaveEnabled()) {
        // Автосохранение выключено — предлагаем сохранить файл вручную
        showSaveHint(true);
        return;
    }
    if (!state.fileHandle) {
        // Файл на диске ещё не выбран — НЕ скачиваем молча новые файлы
        showSaveHint(true);
        setStatus('Автосохранение: нажмите «💾 Сохранить в файл» и выберите файл на диске — изменения будут записываться в него автоматически');
        return;
    }
    clearTimeout(state.autoSaveTimeout);
    state.autoSaveTimeout = setTimeout(() => {
        state.autoSaveTimeout = null;
        autoSaveToDisk();
    }, AUTOSAVE_DEBOUNCE_MS);
}

// Подсветка кнопки «Сохранить в файл» + статусное предложение сохранить
function showSaveHint(show) {
    const btn = document.getElementById('btnSaveFile');
    if (btn) btn.classList.toggle('save-hint', !!show && state.dirty);
    if (show && !autoSaveEnabled() && state.dirty) {
        setStatus('Задание изменено — нажмите «💾 Сохранить в файл», чтобы записать его на диск');
    }
}

// Автосохранение выполняется ТОЛЬКО в выбранный файл на диске (File System Access API).
async function autoSaveToDisk() {
    const content = els.xmlEditor.value || generateXml();
    try {
        if (state.fileHandle && await ensureFilePermission(state.fileHandle)) {
            await writeFileHandle(state.fileHandle, content);
            showSaveHint(false);
            recordDiskSave();
            setStatus('Автосохранено на диск: ' + state.fileHandle.name + ' в ' + new Date().toLocaleTimeString());
            return;
        }
        // Доступ к файлу потерян (например, после перезагрузки страницы)
        state.fileHandle = null;
        showSaveHint(true);
        setStatus('Автосохранение приостановлено: выберите файл через «💾 Сохранить в файл»');
    } catch (e) {
        setStatus('Ошибка автосохранения на диск: ' + e.message);
        showToast('Автосохранение: ' + e.message, true);
    }
}

async function ensureFilePermission(handle, requestWrite = true) {
    if (!handle || !handle.requestPermission) return true; // Firefox и т.п. — без API проверки
    try {
        const opts = { mode: 'readwrite' };
        let status = await handle.queryPermission(opts);
        if (status === 'granted') return true;
        if (!requestWrite) return false;
        status = await handle.requestPermission(opts);
        return status === 'granted';
    } catch (e) {
        return false;
    }
}

async function writeFileHandle(handle, content) {
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
}

function downloadBlob(content, fileName, statusPrefix = 'Файл сохранён: ') {
    const blob = new Blob([content], { type: 'text/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(statusPrefix + fileName);
}

function suggestedFileName() {
    const base = (state.formData.name || 'formula_test')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .trim()
        .slice(0, 80) || 'formula_test';
    return base.endsWith('.xml') ? base : base + '.xml';
}

// ============================================================
// Загрузка задания из файла на диске (File System Access API + fallback)
// Открытый файл становится «рабочим»: дальнейшие сохранения пишутся в него.
// ============================================================
async function loadFromDiskFile() {
    let handle = null;
    let content = null;
    let fileName = null;

    if (window.showOpenFilePicker) {
        try {
            [handle] = await window.showOpenFilePicker({
                multiple: false,
                types: [{ description: 'XML-задание', accept: { 'text/xml': ['.xml'], 'application/xml': ['.xml'] } }],
            });
        } catch (e) {
            if (e && e.name === 'AbortError') return;  // пользователь отменил
            // прочие ошибки — падаем на <input type=file>
        }
    }

    if (!handle) {
        const picked = await pickFileViaInput();
        if (!picked) return;
        content = picked.content;
        fileName = picked.name;
    } else {
        if (!(await ensureFilePermission(handle, true))) {
            return showToast('Нет доступа на запись к выбранному файлу', true);
        }
        const fileObj = await handle.getFile();
        content = await fileObj.text();
        fileName = handle.name;
    }

    if (!content || !content.trim()) {
        return showToast('Файл пуст', true);
    }

    if (!parseXmlToData(content)) {
        return; // parseXmlToData уже показал ошибку разбора
    }

    state.fileHandle = handle;      // null в браузерах без FSAA — сохранение через скачивание
    state.loadedFileName = fileName;
    state.currentFormulaIndex = 0;
    renderFormula();
    updateXmlOutput({ immediate: true, silent: true });
    state.dirty = false;
    showSaveHint(false);
    setStatus('Загружен файл: ' + fileName +
        (handle ? ' — сохранения идут в него' : ' — сохранение будет через скачивание'));
    showToast('Файл «' + fileName + '» загружен (' + state.formData.formulas.length + ' форм.) и назначен для сохранений');
}

// Fallback: стандартный <input type="file">
function pickFileViaInput() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xml,text/xml,application/xml';
        input.style.display = 'none';
        document.body.appendChild(input);
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(val);
        };
        input.addEventListener('change', async () => {
            const f = input.files && input.files[0];
            if (!f) return finish(null);
            finish({ name: f.name, content: await f.text() });
        });
        // Отмена диалога в некоторых браузерах отслеживается фокусом окна
        const onFocus = () => setTimeout(() => {
            if (!input.files || !input.files.length) finish(null);
            window.removeEventListener('focus', onFocus);
        }, 500);
        window.addEventListener('focus', onFocus);
        input.click();
    });
}

async function saveToFile() {
    const content = els.xmlEditor.value || generateXml();
    const fileName = state.loadedFileName || suggestedFileName();

    // Если файл на диске уже выбран — пишем прямо в него, без повторных диалогов
    if (state.fileHandle && await ensureFilePermission(state.fileHandle)) {
        try {
            await writeFileHandle(state.fileHandle, content);
            state.dirty = false;
            showSaveHint(false);
            recordDiskSave();
            setStatus('Сохранено в файл: ' + state.fileHandle.name);
            showToast('Файл сохранён на диск');
            return;
        } catch (e) { /* падаем на диалог выбора файла */ }
    }

    // Диалог выбора места сохранения (Chrome/Edge). Файл запоминается —
    // дальше автосохранение пишет в него без вопросов.
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description: 'XML', accept: { 'text/xml': ['.xml'] } }],
            });
            await writeFileHandle(handle, content);
            state.fileHandle = handle;
            state.dirty = false;
            showSaveHint(false);
            recordDiskSave();
            setStatus('Сохранено в файл: ' + handle.name + (autoSaveEnabled() ? ' (автосохранение в него включено)' : ''));
            showToast('Файл выбран и сохранён — дальнейшие изменения пишутся в него');
            return;
        } catch (e) {
            if (e.name === 'AbortError') return; // пользователь отменил
            // прочие ошибки — падаем на download-fallback
        }
    }

    // Браузер без File System Access API (Firefox/Safari) — стандартное скачивание
    downloadBlob(content, fileName);
    state.dirty = false;
    showSaveHint(false);
    recordDiskSave();
    showToast('Файл сохранён на диск (скачан)');
}

// «Применить ▶»: XML -> редактор. После применения предлагаем сохранить задание в файл.
function applyXmlChanges() {
    const applied = withApplyingXml(() => parseXmlToData(els.xmlEditor.value));
    if (!applied) return;
    state.currentFormulaIndex = 0;
    renderFormula();
    // Информация из XML применена — изменения есть, предлагаем сохранить
    markTaskChanged();
    showToast('XML применён к редактору');
    confirmSaveAfterApply();
}

// Диалог «Сохранить применённое XML-задание в файл?». Важно: window.confirm
// блокирует поток, поэтому showSaveFilePicker вызываем асинхронно.
function confirmSaveAfterApply() {
    Promise.resolve().then(() => {
        const ok = window.confirm('Информация из XML применена.\n\nСохранить задание в файл на диске?');
        if (!ok) {
            setStatus('Задание изменено, но не сохранено — нажмите «💾 Сохранить в файл», когда будете готовы');
            return;
        }
        setTimeout(() => saveToFile(), 0);
    });
}

function copyXml() {
    navigator.clipboard.writeText(els.xmlEditor.value);
    showToast('XML скопирован в буфер обмена');
}

// ============================================================
// Проверка готовности задания + панель «Обзор» (правая)
// ============================================================

// Проблемы по всем формулам (для индикатора публикации и панели обзора)
function findFormulaIssues() {
    const issues = [];
    state.formData.formulas.forEach((f, fi) => {
        const list = computeIssues(f, false);
        if (list.length) issues.push({ index: fi, reasons: list });
    });
    return issues;
}

function isPublishReady() {
    return findFormulaIssues().length === 0;
}

// Обновление индикатора готовности рядом с кнопкой «Публикация»
function updatePublishReadiness() {
    const note = els.publishCheckNote;
    if (!note) return;
    const issues = findFormulaIssues();
    note.classList.toggle('hidden', issues.length === 0);
    if (issues.length) {
        note.textContent = '⚠ формул не готово: ' + issues.length;
    }
}

function toggleReviewPanel() {
    if (els.reviewPanel.classList.contains('hidden')) showReviewPanel();
    else hideReviewPanel();
}

function showReviewPanel() {
    renderReviewPanel();
    els.reviewPanel.classList.remove('hidden');
    els.btnToggleReview.classList.add('active');
}

function hideReviewPanel() {
    els.reviewPanel.classList.add('hidden');
    els.btnToggleReview.classList.remove('active');
}

// Быстрый пролистыватель всех формул с проверкой готовности;
// клик по карточке открывает нужную формулу в редакторе.
function renderReviewPanel() {
    const body = els.reviewBody;
    let total = 0, bad = 0;

    body.innerHTML = state.formData.formulas.map((f, fi) => {
        total++;
        const issues = computeIssues(f, true);
        const ok = issues.length === 0;
        if (!ok) bad++;
        const detail = ok
            ? '<span class="review-formula">' + renderLatexInline(f.latex) + '</span>'
            : '⚠ ' + escHtml(issues.join(' · '));
        return `<div class="review-item ${ok ? 'ok' : 'bad'}" data-q="${fi}" title="Открыть формулу ${fi + 1} в редакторе">
            <div class="review-q"><span class="badge badge-choice">Формула</span> F${fi + 1}: ${escHtml(f.name || '(без названия)')}</div>
            <div class="review-a ${ok ? '' : 'missing'}">${ok ? '✔ ' : ''}${detail}</div>
        </div>`;
    }).join('');

    if (!total) body.innerHTML = '<div class="review-empty">В задании ещё нет формул.</div>';

    els.reviewSummary.textContent = total
        ? (bad ? '⚠ ' + bad + ' из ' + total + ' не готово' : '✓ ' + total + ' формул готово')
        : '';
    els.reviewSummary.classList.toggle('bad', bad > 0);

    body.querySelectorAll('.review-item').forEach(item => {
        item.addEventListener('click', () => {
            goToFormula(+item.dataset.q);
            // Подсветим карточку формулы в редакторе
            const card = els.formulaCard;
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                card.classList.add('flash-highlight');
                setTimeout(() => card.classList.remove('flash-highlight'), 1200);
            }
        });
    });
}

// ============================================================
// Публикация: GitHub Gist (только по кнопке, возвращает ссылку)
// ============================================================
function togglePublishMenu() {
    els.publishMenu.classList.toggle('hidden');
}
function hidePublishMenu() { if (els.publishMenu) els.publishMenu.classList.add('hidden'); }

// Публикация в Gist: если GIST уже привязан — обновляем его, иначе создаём новый.
function publishToGist() {
    if (!checkBeforePublish()) return;
    if (state.gistId) return saveToGist();
    return createNewGist();
}

// Проверка готовности к публикации; при проблемах — открываем панель обзора.
function checkBeforePublish() {
    const issues = findFormulaIssues();
    if (!issues.length) return true;
    showReviewPanel();
    const list = issues.slice(0, 8)
        .map(i => `F${i.index + 1} — ${i.reasons.join('; ')}`)
        .join('\n') + (issues.length > 8 ? `\n…и ещё ${issues.length - 8}` : '');
    showToast('Публикация невозможна: не все формулы готовы к тесту (' + issues.length + ')', true);
    setStatus('Проверка перед публикацией: формул с проблемами — ' + issues.length);
    alert('Перед публикацией нужно исправить все формулы.\n\nПроблемные формулы:\n' + list + '\n\nОни отмечены красным в панели «Обзор» справа.');
    return false;
}

// Ссылка на задание в приложении тестирования (открывается по raw-ссылке XML)
function buildTaskUrl() {
    if (!state.rawUrl) return state.gistUrl || '';
    return TEST_APP_BASE_URL + '?file=' + encodeURIComponent(state.rawUrl);
}

// Показать ссылку на задание после публикации: статус + toast + копирование
function showPublishedLink(title, link) {
    setStatus(`${title}. Ссылка скопирована в буфер обмена`);
    showToast(`${title}: ${link}`, false);
    if (link && navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
}

// Ссылка на задание — показывается в строке названия теста: ссылка + копировать + открыть.
function updateGistLinkDisplay() {
    const link = buildTaskUrl();
    if (link) {
        els.publishedTaskLink.href = link;
        els.publishedTaskLink.textContent = link;
        els.gistLinkContainer.classList.remove('hidden');
    } else {
        els.gistLinkContainer.classList.add('hidden');
    }
}

// Копирование ссылки на задание (кнопка рядом со ссылкой)
function copyTaskUrl() {
    const link = buildTaskUrl();
    if (!link) return showToast('Задание ещё не опубликовано', true);
    navigator.clipboard.writeText(link);
    showToast('Ссылка на задание скопирована');
}

async function createNewGist() {
    const token = getGithubToken();
    if (!token) return showToast('Укажите GitHub Token (⚙ Настройки)', true);

    try {
        setStatus('Создание нового GIST…');
        const res = await fetch('https://api.github.com/gists', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description: state.formData.name || 'Formula Test',
                public: false,
                files: { [state.gistFilename]: { content: els.xmlEditor.value || generateXml() } },
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        state.gistId = data.id;
        state.gistUrl = data.html_url;
        state.rawUrl = data.files[state.gistFilename] ? data.files[state.gistFilename].raw_url : null;
        state.dirty = false;

        updateGistLinkDisplay();
        showPublishedLink('GIST опубликован', buildTaskUrl());
    } catch (e) {
        setStatus('Ошибка создания GIST: ' + e.message);
        showToast('Создание не удалось: ' + e.message, true);
    }
}

// Запись задания в привязанный GIST. Вызывается из «Публикация» (не silent)
// и из автосохранения / «Открыть задание» (silent — без дублирующих toast).
async function saveToGist(opts = {}) {
    const token = getGithubToken();
    if (!state.gistId || !token) return;
    if (state.isSaving) { state.needsAnotherSave = true; return; }
    state.isSaving = true;

    setStatus('Сохранение в GIST…');
    try {
        const res = await fetch(`https://api.github.com/gists/${state.gistId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description: state.formData.name || 'Formula Test',
                files: { [state.gistFilename]: { content: els.xmlEditor.value || generateXml() } },
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        const fd = data.files[state.gistFilename];
        if (fd && fd.raw_url) state.rawUrl = fd.raw_url;
        setStatus('Обновлено в GIST в ' + new Date().toLocaleTimeString());
        if (!opts.silent) showPublishedLink('Обновлено в GIST', buildTaskUrl());
        else updateGistLinkDisplay();
    } catch (e) {
        if (String(e.message).toLowerCase().includes('blocked')) {
            setStatus('GIST занят, повтор…');
            scheduleGistSave();
        } else {
            setStatus('Ошибка сохранения в GIST: ' + e.message);
            showToast('Публикация не удалась: ' + e.message, true);
        }
    } finally {
        state.isSaving = false;
        if (state.needsAnotherSave) {
            state.needsAnotherSave = false;
            saveToGist(opts);
        }
    }
}

// Автосохранение задания в привязанный GIST (после первой публикации/загрузки)
function scheduleGistSave() {
    if (!state.gistId || !getGithubToken()) return;
    setStatus('Есть несохранённые изменения…');
    clearTimeout(state.gistSaveTimeout);
    state.gistSaveTimeout = setTimeout(() => {
        state.gistSaveTimeout = null;
        saveToGist({ silent: true });
    }, AUTOSAVE_DEBOUNCE_MS);
}

function openExternal(url) { window.open(url, '_blank', 'noopener'); }

async function openTask() {
    if (!state.gistId) return showToast('Сначала опубликуйте задание (🚀 Публикация)', true);

    copyTaskUrl();
    // Открываем окно синхронно (иначе блокировщик всплывающих окон), затем сохраняем изменения
    const win = window.open('about:blank', '_blank');
    try {
        if (state.dirty || state.gistSaveTimeout) {
            clearTimeout(state.gistSaveTimeout);
            state.gistSaveTimeout = null;
            await saveToGist({ silent: true });
        }
    } catch (e) { /* продолжаем даже при ошибке сохранения */ }

    if (!state.rawUrl) {
        if (win) win.close();
        return showToast('Raw-ссылка недоступна', true);
    }

    const taskUrl = buildTaskUrl();
    navigator.clipboard.writeText(taskUrl).catch(() => {});
    if (win) { win.opener = null; win.location.href = taskUrl; }
    else { openExternal(taskUrl); }
    showToast('Ссылка на задание скопирована и открыта');
}

// ============================================================
// Загрузка из Gist
// ============================================================
function extractGistId(input) {
    input = (input || '').trim();
    if (!input) return null;
    try {
        const u = new URL(input);
        const f = u.searchParams.get('file') || u.searchParams.get('name');
        if (f) input = f;
    } catch (e) { /* не URL */ }
    const m = input.match(/(?:gist\.github\.com|gist\.githubusercontent\.com)\/(?:[^/\s]+\/)?([0-9a-f]{7,})/i);
    if (m) return m[1];
    if (/^[0-9a-f]{7,}$/i.test(input)) return input;
    return null;
}

async function loadFromGist() {
    const token = getGithubToken();
    const input = els.loadGistId.value.trim();
    if (!token || !input) return showToast('Нужны GitHub Token и ссылка на GIST', true);

    const id = extractGistId(input);
    if (!id) return showToast('Не удалось определить ID GIST', true);

    try {
        setStatus('Загрузка GIST…');
        const res = await fetch(`https://api.github.com/gists/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        let fileName = null;
        if (data.files[state.gistFilename]) {
            fileName = state.gistFilename;
        } else {
            const names = Object.keys(data.files);
            fileName = names.find(n => n.toLowerCase().endsWith('.xml')) || names[0];
        }
        const file = data.files[fileName];
        if (!file) throw new Error('В GIST нет файлов');

        if (parseXmlToData(file.content)) {
            state.gistId = data.id;
            state.gistUrl = data.html_url || ('https://gist.github.com/' + id);
            state.gistFilename = fileName;
            state.rawUrl = file.raw_url || null;

            // Название теста берём из описания GIST (если это не подпись по умолчанию)
            state.formData.name = data.description && data.description !== 'Formula Test'
                ? data.description : '';
            els.quizName.value = state.formData.name;

            updateGistLinkDisplay();
            state.currentFormulaIndex = 0;
            renderFormula();
            updateXmlOutput({ immediate: true, silent: true });
            state.dirty = false;
            showSaveHint(false);
            hideLoadModal();
            setStatus('GIST загружен: ' + state.formData.formulas.length + ' форм.');
            showToast('GIST загружен');
        } else {
            setStatus('Готово');
        }
    } catch (e) {
        setStatus('Ошибка загрузки: ' + e.message);
        showToast('Загрузка не удалась: ' + e.message, true);
    }
}


// ============================================================
// DeepSeek: отправка XML + промпта, обработка ответа
// ============================================================

// Применить XML — ответ DeepSeek — к редактору; вернуть true, если XML корректен.
function applyDeepSeekXml(xml) {
    return withApplyingXml(() => {
        const parsedOk = parseXmlToData(xml);
        if (parsedOk) {
            state.currentFormulaIndex = 0;
            renderFormula();
        }
        return parsedOk;
    });
}

function extractXmlFromText(text) {
    if (!text) return '';
    // убираем markdown-обёртки ```xml ... ```
    const fenced = text.match(/```(?:xml)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('<formulas');
    const end = candidate.lastIndexOf('</formulas>');
    if (start !== -1 && end !== -1) return candidate.slice(start, end + '</formulas>'.length).trim();
    return candidate.trim();
}

// Отправка одного сообщения в DeepSeek; возвращает текст ответа модели.
async function deepseekChat(token, messages) {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages, stream: false }),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* не-JSON ответ */ }
    if (!res.ok) {
        throw new Error((data && ((data.error && data.error.message) || data.message)) || 'HTTP ' + res.status);
    }
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : null;
    if (!reply) throw new Error('Некорректный ответ модели');
    return reply;
}

// Индикатор прогресса: статусная строка + «живое» оверлей-окно (см. setUiBusy)
let aiProgressTimer = null;
let aiElapsedTimer = null;
let aiProgressDots = 0;
let aiStartedAt = 0;

function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// Обновление содержимого оверлея (таймер, этап, пульсирующие точки)
function renderAiOverlay() {
    const box = document.getElementById('aiOverlayStage');
    if (!box) return;
    const el = document.getElementById('aiOverlayElapsed');
    if (el && aiStartedAt) el.textContent = fmtElapsed(Date.now() - aiStartedAt);
    box.textContent = els.statusText.textContent.replace(/\s*[·]+\s*$/, '');
    const dots = document.getElementById('aiOverlayDots');
    if (dots) dots.textContent = '·'.repeat(aiProgressDots % 4) || ' ';
}

function setAiProgress(text) {
    setStatus((text || 'DeepSeek: обработка…') + ' ' + '·'.repeat(aiProgressDots % 4));
    renderAiOverlay();
}

function startAiProgress() {
    stopAiProgress();
    aiProgressDots = 0;
    aiStartedAt = Date.now();
    setAiProgress('Отправка запроса в DeepSeek');
    aiProgressTimer = setInterval(() => {
        aiProgressDots++;
        const base = els.statusText.textContent.replace(/\s*[·]+\s*$/, '');
        setStatus(base + ' ' + '·'.repeat(aiProgressDots % 4));
        renderAiOverlay();
    }, 500);
    aiElapsedTimer = setInterval(renderAiOverlay, 1000);
}

function updateAiStage(text) {
    if (!state.aiBusy) return;
    setStatus(text + ' ' + '·'.repeat(aiProgressDots % 4));
    renderAiOverlay();
}

function stopAiProgress() {
    if (aiProgressTimer) { clearInterval(aiProgressTimer); aiProgressTimer = null; }
    if (aiElapsedTimer) { clearInterval(aiElapsedTimer); aiElapsedTimer = null; }
}

// Блокировка/разблокировка интерфейса на время обращения к DeepSeek.
// Окно ожидания: градиентная карточка, «орбита» со спутником, таймер, этапы.
function setUiBusy(busy, reasonText) {
    state.aiBusy = busy;
    document.body.classList.toggle('ai-busy', busy);
    let overlay = document.getElementById('aiOverlay');
    if (busy) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'aiOverlay';
            overlay.className = 'ai-overlay';
            overlay.innerHTML =
                '<div class="ai-overlay-box">' +
                '<div class="ai-orbit" aria-hidden="true">' +
                '<span class="ai-core">✨</span>' +
                '<span class="ai-satellite"></span>' +
                '<span class="ai-ring ai-ring-1"></span>' +
                '<span class="ai-ring ai-ring-2"></span>' +
                '</div>' +
                '<div class="ai-overlay-title">DeepSeek думает<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span></div>' +
                '<div class="ai-overlay-text" id="aiOverlayStage">Отправка запроса…</div>' +
                '<div class="ai-overlay-timer-row">Прошло времени: <span class="ai-timer" id="aiOverlayElapsed">00:00</span><span id="aiOverlayDots"></span></div>' +
                '<div class="ai-overlay-hint">Интерфейс заблокирован до получения ответа — глубокие задания могут занять несколько минут.</div>' +
                '</div>';
            document.body.appendChild(overlay);
        }
        renderAiOverlay();
    } else if (overlay) {
        overlay.remove();
    }
    ['btnAskDeepSeek', 'btnApplyXml', 'btnCopyXml', 'btnSaveFile', 'btnPublish', 'btnLoadGist', 'btnLoadDiskFile', 'btnNewQuiz', 'btnSettings']
        .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = busy; });
    if (els.xmlEditor) els.xmlEditor.readOnly = busy;
    if (els.promptText) els.promptText.readOnly = busy;
}

async function askDeepSeek(mode) {
    if (state.aiBusy) return;   // повторный клик во время обработки игнорируется
    mode = mode || currentDsMode();
    localStorage.setItem(LS.dsMode, mode);
    renderModeSelect();

    const token = getDeepseekToken();
    const xml = els.xmlEditor.value || generateXml();
    if (!xml.trim()) return showToast('XML пуст', true);

    // Промпт должен быть загружен — иначе просим загрузить из Gist
    const activePrompt = getPromptById(mode) || state.prompts[0];
    if (!activePrompt || !activePrompt.text.trim()) {
        showToast('Промпт «' + (activePrompt ? activePrompt.name : mode) + '» ещё не загружен — нажмите «↻ Gist»', true);
        reloadActivePromptFromGist();
        return;
    }

    // Без токена: копировать промпт+XML в буфер и открыть чат DeepSeek
    if (!token) {
        const payload = buildDsMessage(mode);
        try { await navigator.clipboard.writeText(payload); } catch (e) { /* не критично */ }
        showToast('Промпт и XML скопированы — вставьте их в чат DeepSeek (открыт в новом окне)');
        openExternal('https://chat.deepseek.com/');
        return;
    }

    const modeName = activePrompt.name;
    // Блокируем интерфейс и показываем прогресс на всё время обращения
    setUiBusy(true, 'DeepSeek (промпт «' + modeName + '»): обработка задания…');
    startAiProgress();
    try {
        const messages = [{ role: 'user', content: buildDsMessage(mode) }];
        let fullReply = '';
        // Модель могла не закончить задание за один ответ — просим продолжить (макс. 3 раза)
        for (let i = 0; i < 4; i++) {
            updateAiStage(i === 0
                ? 'DeepSeek (' + modeName + '): запрос отправлен, ждём ответ…'
                : 'DeepSeek (' + modeName + '): продолжение генерации (' + i + '/3)…');
            const reply = await deepseekChat(token, messages);
            fullReply += (i > 0 ? '\n' : '') + reply;
            messages.push({ role: 'assistant', content: reply });
            if (fullReply.includes(READY_MARKER)) break;
            const hasOpen = (fullReply.match(/<formulas/g) || []).length;
            const hasClose = (fullReply.match(/<\/formulas>/g) || []).length;
            if (hasOpen > 0 && hasOpen === hasClose && extractXmlFromText(fullReply).includes('</formula>')) {
                break; // XML выглядит завершённым, даже если модель забыла маркер
            }
            if (i === 3) break;
            messages.push({ role: 'user', content: 'Задание ещё не готово (нет финального XML и маркера ' + READY_MARKER + '). Продолжи и выдай ПОЛНЫЙ готовый XML целиком, без пояснений.' });
        }

        stopAiProgress();
        updateAiStage('Ответ получен — применяю к редактору…');
        const resultXml = extractXmlFromText(fullReply);
        if (!resultXml || !resultXml.includes('<formulas')) {
            // DeepSeek прислал НЕ XML: открываем редактируемое окно результата
            setUiBusy(false);
            showDsResultWindow(fullReply, mode);
            setStatus('DeepSeek: ответ не является XML — открыт в окне результата');
            return;
        }
        hideDsResultWindow();
        els.xmlEditor.value = resultXml;
        // Результат сразу применяем к редактору; автосохранение запишет его на диск / в Gist
        const parsedOk = applyDeepSeekXml(resultXml);
        markTaskChanged();
        if (parsedOk) {
            showToast('Ответ DeepSeek применён к XML и редактору');
        } else {
            showToast('Ответ получен, но XML некорректен — проверьте панель XML', true);
        }
        setStatus('DeepSeek: ответ получен и применён');
    } catch (e) {
        console.error(e);
        setStatus('DeepSeek: ошибка — ' + e.message);
        showToast('DeepSeek: ' + e.message, true);
    } finally {
        stopAiProgress();
        setUiBusy(false);
    }
}

// ============================================================
// Окно результата DeepSeek (когда ответ пришёл НЕ в виде XML)
// Редактируемый текст + кнопки: Копировать / Закрыть / Отправить в DeepSeek
// ============================================================
let dsResultMode = null;   // режим (id промпта), в котором был получен не-XML ответ

function buildDsResultWindow() {
    if (document.getElementById('dsResultModal')) return;
    const div = document.createElement('div');
    div.id = 'dsResultModal';
    div.className = 'modal-overlay';
    div.innerHTML = `
        <div class="modal modal-xl" style="display: flex; flex-direction: column;">
            <div class="modal-header">
                <h3>🤖 Ответ DeepSeek — не XML</h3>
                <button type="button" class="btn-icon" data-close title="Закрыть">✕</button>
            </div>
            <div class="modal-body" style="display:flex; flex-direction:column; gap:0.7rem;">
                <div class="ds-result-warning">⚠ Модель прислала результат не в формате XML-задания.
                    Текст можно отредактировать вручную, скопировать или отправить обратно в DeepSeek
                    (например, с уточнением, что нужен XML по шаблону).</div>
                <div id="dsResultInfo" class="prompt-editor-info"></div>
                <textarea id="dsResultArea" class="ds-result-area" spellcheck="false"></textarea>
            </div>
            <div class="ds-result-footer">
                <button type="button" class="btn" id="btnDsResultCopy">📋 Копировать</button>
                <button type="button" class="btn btn-secondary" data-close>Закрыть</button>
                <button type="button" class="btn btn-primary" id="btnDsResultSend">🤖 Отправить в DeepSeek</button>
            </div>
        </div>`;
    document.body.appendChild(div);
    els.dsResultModal = div;
    els.dsResultArea = div.querySelector('#dsResultArea');
    els.dsResultInfo = div.querySelector('#dsResultInfo');
    div.addEventListener('click', (e) => {
        if (e.target === div || (e.target.closest && e.target.closest('[data-close]'))) hideDsResultWindow();
    });
    div.querySelector('#btnDsResultCopy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(els.dsResultArea.value);
            showToast('Текст ответа скопирован в буфер обмена');
        } catch (err) { showToast('Не удалось скопировать', true); }
    });
    div.querySelector('#btnDsResultSend').addEventListener('click', () => {
        sendDsResultToDeepSeek(els.dsResultArea.value, dsResultMode || currentDsMode());
    });
}

function showDsResultWindow(text, mode) {
    buildDsResultWindow();
    dsResultMode = mode;
    els.dsResultArea.value = text;
    const p = getPromptById(mode) || state.prompts[0];
    els.dsResultInfo.textContent = 'Режим: «' + (p ? p.name : mode) + '» · длина ответа: ' + text.length + ' симв.';
    els.dsResultModal.classList.add('show');
    els.dsResultArea.focus();
}

function hideDsResultWindow() {
    if (!els.dsResultModal) return;
    els.dsResultModal.classList.remove('show');
}

// Отправка отредактированного текста окна обратно в DeepSeek.
async function sendDsResultToDeepSeek(userText, mode) {
    const token = getDeepseekToken();
    if (!token) { showToast('Не указан токен DeepSeek (⚙ Настройки)', true); return; }
    if (!userText.trim()) { showToast('Текст для отправки пуст', true); return; }
    const p = getPromptById(mode) || state.prompts[0];
    setUiBusy(true, 'DeepSeek (' + (p ? p.name : mode) + '): повторная отправка…');
    startAiProgress();
    try {
        const messages = [{ role: 'user', content: userText }];
        let fullReply = '';
        for (let i = 0; i < 4; i++) {
            updateAiStage(i === 0 ? 'Отправлено, ждём ответ…' : 'Продолжение генерации (' + i + '/3)…');
            const reply = await deepseekChat(token, messages);
            fullReply += (i > 0 ? '\n' : '') + reply;
            messages.push({ role: 'assistant', content: reply });
            const probe = extractXmlFromText(fullReply);
            if (fullReply.includes(READY_MARKER) || (probe && probe.includes('<formulas'))) break;
            if (i === 3) break;
            messages.push({ role: 'user', content: 'Задание ещё не готово. Выдай ПОЛНЫЙ готовый XML целиком, без пояснений.' });
        }
        stopAiProgress();
        const resultXml = extractXmlFromText(fullReply);
        if (resultXml && resultXml.includes('<formulas')) {
            hideDsResultWindow();
            els.xmlEditor.value = resultXml;
            const parsedOk = applyDeepSeekXml(resultXml);
            markTaskChanged();
            showToast(parsedOk ? 'Ответ DeepSeek применён к XML и редактору' : 'Ответ получен, но XML некорректен — проверьте панель XML', !parsedOk);
            setStatus('DeepSeek: ответ применён');
        } else {
            showDsResultWindow(fullReply, mode);
            setStatus('DeepSeek: ответ снова не XML — осталось в окне результата');
        }
    } catch (e) {
        console.error(e);
        stopAiProgress();
        showToast('DeepSeek: ' + e.message, true);
        setStatus('DeepSeek: ошибка — ' + e.message);
    } finally {
        stopAiProgress();
        setUiBusy(false);
    }
}

// ============================================================
// UI-хелперы
// ============================================================
function showToast(msg, isErr = false) {
    const t = els.toast;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' error' : '');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

function setStatus(text) {
    els.statusText.textContent = text;
}

function showLoadModal() { els.loadModal.classList.add('show'); els.loadGistId.focus(); }
function hideLoadModal() { els.loadModal.classList.remove('show'); }
function showSettingsModal() { els.settingsModal.classList.add('show'); }
function hideSettingsModal() { els.settingsModal.classList.remove('show'); saveSettings(); }

// ============================================================
// Resizer для XML-панели (тянем за правую границу — меняем ширину)
// ============================================================
function initResizer() {
    const resizer = els.resizer;
    const panel = els.xmlPanel;
    let startX = 0, startW = 0;

    const doDrag = (e) => {
        const x = e.clientX ?? ((e.touches && e.touches[0]) ? e.touches[0].clientX : x);
        const w = Math.max(220, Math.min(window.innerWidth * 0.7, startW + (x - startX)));
        panel.style.width = w + 'px';
    };
    const stopDrag = () => {
        document.removeEventListener('mousemove', doDrag);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('touchmove', doDrag);
        document.removeEventListener('touchend', stopDrag);
        resizer.classList.remove('active');
    };
    const start = (e) => {
        startX = e.clientX ?? ((e.touches && e.touches[0]) ? e.touches[0].clientX : 0);
        startW = panel.getBoundingClientRect().width;
        resizer.classList.add('active');
        document.addEventListener('mousemove', doDrag);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchmove', doDrag);
        document.addEventListener('touchend', stopDrag);
        e.preventDefault();
    };
    resizer.addEventListener('mousedown', start);
    resizer.addEventListener('touchstart', start, { passive: false });
}
