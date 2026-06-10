import {
    chat,
    eventSource,
    event_types,
    saveChatConditional,
    saveSettingsDebounced,
    updateMessageBlock,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { toggleDrawer } from '../../../utils.js';

const extensionName = 'codex-aux-bridge';
const settingsUrl = '/scripts/extensions/third-party/codex-aux-bridge/settings.html';
const stateFileName = 'codex-aux-bridge-state.json';
const taskFilePrefix = 'codex-aux-bridge-task';
const stateSchema = 'codex-aux-bridge.state.v1';
const taskSchema = 'codex-aux-bridge.task.v1';
const floatingButtonId = 'codex_aux_floating_button';
const panelId = 'codex_aux_bridge_settings';
const inlineSettingsId = 'codex_aux_bridge_settings_inline';

const defaultSettings = {
    enabled: true,
    panelOpen: false,
    panelLeft: null,
    panelTop: null,
    contextAssistantFloors: 3,
    maxCharsPerFloor: 1400,
    redactExplicit: true,
    format: {
        enabled: true,
        wrapTime: true,
        wrapContent: true,
        wrapNowPlot: false,
        removeStatusPlaceholder: true,
    },
    world: {
        enabled: true,
        mode: 'codex',
        includeExistingWorldEngineSnapshot: true,
        evolutionIntensity: 'balanced',
        timePolicy: 'infer',
        timeScale: 'auto',
        locationPolicy: 'strict',
        maxEventUpdates: 5,
        allowOffscreenEvents: true,
        requireCausalEvidence: true,
    },
    search: {
        enabled: true,
        scope: 'encyclopedia',
        maxQueries: 3,
        includeWeather: true,
        includeGlobalNews: true,
        includeLocalNews: true,
        includeCalendar: true,
        includeCulture: true,
        includeEconomy: true,
        includeTransport: false,
        maxSources: 8,
    },
};

let lastTaskFile = '';
let exportTimer = null;
let floatingPanelOpen = false;
let panelLoadPromise = null;
let extensionSettingsObserver = null;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeSettings(base, saved) {
    const output = clone(base);
    for (const [key, value] of Object.entries(saved || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object') {
            output[key] = mergeSettings(output[key], value);
        } else {
            output[key] = value;
        }
    }
    return output;
}

function getSettings() {
    extension_settings[extensionName] = mergeSettings(defaultSettings, extension_settings[extensionName] || {});
    return extension_settings[extensionName];
}

function setByPath(object, path, value) {
    const parts = String(path).split('.');
    let cursor = object;
    while (parts.length > 1) {
        const part = parts.shift();
        cursor[part] = cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : {};
        cursor = cursor[part];
    }
    cursor[parts[0]] = value;
}

function getByPath(object, path) {
    return String(path).split('.').reduce((cursor, part) => cursor?.[part], object);
}

function setStatus(text, error = false) {
    document.querySelectorAll('.codex-aux-status').forEach(element => {
        element.textContent = text;
        element.classList.toggle('error', !!error);
    });
    const floatingStatus = document.getElementById('codex_aux_floating_status');
    if (floatingStatus) {
        floatingStatus.textContent = text;
        floatingStatus.classList.toggle('error', !!error);
    }
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

async function saveUserJsonFile(fileName, data) {
    const context = getContext();
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            name: fileName,
            data: encodeBase64Utf8(JSON.stringify(data, null, 2)),
        }),
    });
    if (!response.ok) {
        throw new Error(`failed to save ${fileName}: ${response.status} ${await response.text()}`);
    }
    return response.json().catch(() => ({}));
}

function safeId(value = '') {
    return String(value || 'default')
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'default';
}

function stripBridgeInlineBlocks(text = '') {
    return String(text || '').replace(/<!--\s*codex-image-bridge-inline-start\s*-->[\s\S]*?<!--\s*codex-image-bridge-inline-end\s*-->/gi, '');
}

function stripNonStoryBlocks(text = '') {
    return stripBridgeInlineBlocks(text)
        .replace(/<codex-(?:think|image|ui)\b[^>]*>[\s\S]*?<\/codex-(?:think|image|ui)>/gi, '')
        .replace(/<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable>/gi, '')
        .replace(/<Analysis\b[^>]*>[\s\S]*?<\/Analysis>/gi, '')
        .replace(/<JSONPatch\b[^>]*>[\s\S]*?<\/JSONPatch>/gi, '')
        .replace(/<StatusPlaceHolderImpl\s*\/>/gi, '')
        .trim();
}

function redactExplicitTerms(text = '') {
    const terms = [
        /鸡巴|龟头|阴唇|阴道|小穴|阴蒂|淫水|精液|射精|高潮|乳头|乳房|性爱|口交|肛交|做爱|插入|抽插/gi,
        /pussy|penis|cock|cum|sex|orgasm|nude|naked|anal|oral/gi,
    ];
    let output = String(text || '');
    for (const pattern of terms) output = output.replace(pattern, '[redacted]');
    return output;
}

function sanitizeText(text = '', settings = getSettings()) {
    let output = stripNonStoryBlocks(text);
    if (settings.redactExplicit) {
        output = redactExplicitTerms(output);
    }
    output = output.replace(/\s{3,}/g, ' ').trim();
    const limit = Math.max(200, Math.min(4000, Number(settings.maxCharsPerFloor) || defaultSettings.maxCharsPerFloor));
    return output.length > limit ? `${output.slice(0, limit)}...` : output;
}

function getCurrentInfo() {
    const context = getContext();
    return {
        chatId: context.chatId || context.getCurrentChatId?.() || '',
        characterName: context.name2 || '',
        userName: context.name1 || '',
        groupId: context.groupId || '',
    };
}

function findLatestAssistantMessageId() {
    for (let index = chat.length - 1; index >= 0; index--) {
        if (chat[index] && !chat[index].is_user && !chat[index].is_system) {
            return index;
        }
    }
    return -1;
}

function collectRecentFloors(targetMessageId = findLatestAssistantMessageId()) {
    const settings = getSettings();
    const maxAssistant = Math.max(1, Math.min(12, Number(settings.contextAssistantFloors) || defaultSettings.contextAssistantFloors));
    const selected = [];
    let assistantCount = 0;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_system) continue;
        selected.push({
            messageId: index,
            role: message.is_user ? 'user' : 'assistant',
            name: message.name || '',
            sendDate: message.send_date || '',
            isTarget: index === targetMessageId,
            bridge: message.extra?.codex_image_bridge ? {
                jobId: message.extra.codex_image_bridge.jobId || '',
                status: message.extra.codex_image_bridge.status || '',
                imageCount: message.extra.codex_image_bridge.imageCount || 0,
                expectedImageCount: message.extra.codex_image_bridge.expectedImageCount || 0,
            } : null,
            text: sanitizeText(message.mes || '', settings),
        });
        if (!message.is_user) assistantCount += 1;
        if (assistantCount >= maxAssistant) break;
    }
    return selected.reverse();
}

function compactWorldState(state) {
    if (!state || typeof state !== 'object') return null;
    return {
        round: state.round || 0,
        worldDigest: state.worldDigest || '',
        events: Array.isArray(state.events) ? state.events.slice(0, 16) : [],
        factions: Array.isArray(state.factions) ? state.factions.slice(0, 15) : [],
        winds: Array.isArray(state.winds) ? state.winds.slice(0, 12) : [],
        worldTrends: Array.isArray(state.worldTrends) ? state.worldTrends.slice(0, 4) : [],
        reputation: state.reputation || {},
        economy: state.economy || {},
        memories: Array.isArray(state.memories) ? state.memories.slice(0, 24) : [],
        enemies: Array.isArray(state.enemies) ? state.enemies.slice(0, 16) : [],
        influenceChain: Array.isArray(state.influenceChain) ? state.influenceChain.slice(0, 16) : [],
        regionalIncident: state.regionalIncident || {},
        blackbox: state.blackbox || {},
    };
}

function getWorldSnapshot() {
    const settings = getSettings();
    if (!settings.world.enabled || !settings.world.includeExistingWorldEngineSnapshot) return null;
    const core = window.CODEX_WORLD_ENGINE_CORE || window.WORLD_ENGINE_CORE;
    if (!core?.loadState) return null;
    try {
        const state = core.loadState();
        const clean = core.getCleanExport ? core.getCleanExport(state) : state;
        return compactWorldState(clean);
    } catch (error) {
        console.warn('[Codex Aux Bridge] world snapshot failed', error);
        return null;
    }
}

function getFoxSearchSnapshot() {
    const settings = getSettings();
    let legacySettings = null;
    try {
        const raw = localStorage.getItem('websearch_settings');
        legacySettings = raw ? JSON.parse(raw) : null;
    } catch (error) {
        legacySettings = null;
    }
    return {
        enabled: !!settings.search.enabled,
        scope: settings.search.scope,
        maxQueries: Number(settings.search.maxQueries) || defaultSettings.search.maxQueries,
        legacyWebSearchSettings: legacySettings,
    };
}

function extractCandidateQueries(floors = []) {
    const text = floors.map(floor => floor.text || '').join('\n');
    const candidates = new Set();
    const patterns = [
        /《([^》]{2,40})》/g,
        /([A-Z][A-Za-z0-9&.' -]{2,40})/g,
        /([\u4e00-\u9fa5]{2,12}(?:公司|集团|大学|医院|机场|酒店|品牌|城市|地区|事件|奖项|剧组|电影|电视剧|综艺))/g,
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const value = String(match[1] || '').trim();
            if (value.length >= 2) candidates.add(value);
        }
    }
    return [...candidates].slice(0, Math.max(1, Math.min(8, Number(getSettings().search.maxQueries) || 3)));
}

function collectPatternMatches(text, patterns, limit = 8) {
    const output = [];
    const seen = new Set();
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const value = String(match[1] || match[0] || '').replace(/\s+/g, ' ').trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            output.push(value);
            if (output.length >= limit) return output;
        }
    }
    return output;
}

function extractTimeLocationHints(floors = []) {
    const joined = floors.map(floor => `#${floor.messageId} ${floor.text || ''}`).join('\n');
    const timeHints = collectPatternMatches(joined, [
        /((?:现在|当前|此时|时间|日期|今天|今日|明天|昨日|昨晚|今晚|清晨|早上|上午|中午|下午|傍晚|黄昏|夜里|深夜)[^。！？\n]{0,48})/g,
        /(\d{4}[年/-]\d{1,2}[月/-]\d{1,2}[日号]?(?:\s*[上中下]午|\s*\d{1,2}[:：]\d{2})?)/g,
        /(\d{1,2}[:：]\d{2}(?:\s*(?:AM|PM|am|pm))?)/g,
    ], 10);
    const locationHints = collectPatternMatches(joined, [
        /(?:地点|位置|所在地|所在|来到|抵达|回到|前往|在|于)[:：\s]*([一-龥A-Za-z0-9·.' -]{2,36}(?:市|城|镇|村|区|街|路|巷|港|码头|车站|机场|酒店|旅馆|学校|医院|公司|庄园|宅邸|房间|大厅|办公室|广场|公园|山|河|湖|海|岛|星球|基地|舰船|空间站)?)/g,
        /([一-龥A-Za-z0-9·.' -]{2,36}(?:市|城|镇|村|区|街|路|巷|港|码头|车站|机场|酒店|旅馆|学校|医院|公司|庄园|宅邸|房间|大厅|办公室|广场|公园|山|河|湖|海|岛|星球|基地|舰船|空间站))/g,
    ], 10);
    return {
        exportedAt: new Date().toISOString(),
        sourceMessageIds: floors.map(floor => floor.messageId),
        timeHints,
        locationHints,
    };
}

async function exportTaskSnapshot(targetMessageId = findLatestAssistantMessageId()) {
    const settings = getSettings();
    const info = getCurrentInfo();
    const floors = collectRecentFloors(targetMessageId);
    const now = new Date().toISOString();
    const sceneContext = extractTimeLocationHints(floors);
    const taskId = `${safeId(info.chatId)}-${targetMessageId}-${Date.now()}`;
    const taskFile = `${taskFilePrefix}-${taskId}.json`;
    const payload = {
        schema: taskSchema,
        taskId,
        taskFile,
        createdAt: now,
        currentChat: info,
        targetMessageId,
        latestMessageId: chat.length - 1,
        settings: clone(settings),
        sceneContext,
        floors,
        formatTarget: {
            enabled: !!settings.format.enabled,
            targetMessageId,
        },
        worldTask: {
            enabled: !!settings.world.enabled && settings.world.mode !== 'disabled',
            mode: settings.world.mode,
            snapshot: getWorldSnapshot(),
        },
        searchTask: {
            ...getFoxSearchSnapshot(),
            candidateQueries: extractCandidateQueries(floors),
        },
        briefingTask: {
            enabled: !!settings.search.enabled,
            needs: {
                weather: !!settings.search.includeWeather,
                globalNews: !!settings.search.includeGlobalNews,
                localNews: !!settings.search.includeLocalNews,
                calendar: !!settings.search.includeCalendar,
                culture: !!settings.search.includeCulture,
                economy: !!settings.search.includeEconomy,
                transport: !!settings.search.includeTransport,
            },
            maxSources: Number(settings.search.maxSources) || defaultSettings.search.maxSources,
        },
    };
    await saveUserJsonFile(taskFile, payload);
    lastTaskFile = taskFile;
    await saveStateFile();
    setStatus(`已导出 ${taskFile}`);
    return payload;
}

async function saveStateFile() {
    const info = getCurrentInfo();
    const payload = {
        schema: stateSchema,
        enabled: !!getSettings().enabled,
        updatedAt: new Date().toISOString(),
        currentChat: info,
        settings: clone(getSettings()),
        latestTaskFile: lastTaskFile,
    };
    await saveUserJsonFile(stateFileName, payload);
}

function normalizeMessageFormat(text = '', settings = getSettings()) {
    const format = settings.format || {};
    let source = String(text || '');
    if (format.removeStatusPlaceholder) {
        source = source.replace(/\s*<StatusPlaceHolderImpl\s*\/>\s*$/gi, '').trim();
    }
    if (!format.wrapTime && !format.wrapContent && !format.wrapNowPlot) return source;

    let timeBlock = '';
    let body = source.trim();
    const timeMatch = body.match(/^\s*<time\b[^>]*>[\s\S]*?<\/time>\s*/i);
    if (timeMatch) {
        timeBlock = timeMatch[0].trim();
        body = body.slice(timeMatch[0].length).trim();
    } else if (format.wrapTime) {
        const rawTime = body.match(/^\s*(```[^\r\n]*```)([\s\S]*)$/);
        if (rawTime) {
            timeBlock = `<time>\n${rawTime[1].trim()}\n</time>`;
            body = rawTime[2].trim();
        }
    }

    if (format.wrapContent && !/<content\b/i.test(body)) {
        body = `<content>\n${body}\n</content>`;
    }
    if (format.wrapNowPlot && !/<now_plot\b/i.test(body)) {
        body = `<now_plot>\n${body}\n</now_plot>`;
    }
    return [timeBlock, body].filter(Boolean).join('\n').trim();
}

async function repairLatestAssistantMessage() {
    const messageId = findLatestAssistantMessageId();
    if (messageId < 0) {
        setStatus('没有可修复的 assistant 楼层', true);
        return null;
    }
    const message = chat[messageId];
    const nextText = normalizeMessageFormat(message.mes || '');
    if (nextText === message.mes) {
        setStatus(`第 ${messageId} 层无需修复`);
        await exportTaskSnapshot(messageId);
        return { messageId, changed: false };
    }
    message.mes = nextText;
    if (Array.isArray(message.swipes) && message.swipes.length > 0) {
        const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        if (swipeId >= 0 && swipeId < message.swipes.length) {
            message.swipes[swipeId] = nextText;
        }
    }
    updateMessageBlock(messageId, message);
    await saveChatConditional();
    await exportTaskSnapshot(messageId);
    setStatus(`已修复第 ${messageId} 层`);
    return { messageId, changed: true };
}

function writeSettingsToUi() {
    const settings = getSettings();
    $('[data-codex-aux-setting]').each(function () {
        const path = this.dataset.codexAuxSetting;
        const value = getByPath(settings, path);
        if (this.type === 'checkbox') this.checked = !!value;
        else this.value = value ?? '';
    });
}

function readValueFromInput(input) {
    if (input.type === 'checkbox') return !!input.checked;
    if (input.type === 'number') return Number(input.value);
    return input.value;
}

function handleSettingInput(event) {
    const input = event.currentTarget;
    if (!input?.dataset?.codexAuxSetting) return;
    setByPath(getSettings(), input.dataset.codexAuxSetting, readValueFromInput(input));
    writeSettingsToUi();
    saveSettingsDebounced();
    saveStateFile().catch(error => setStatus(error.message, true));
}

function bindSettingsUi(root = document) {
    if (!root || root.dataset?.codexAuxBound === '1') return;
    root.querySelectorAll('[data-codex-aux-setting]').forEach(input => {
        input.addEventListener('input', handleSettingInput);
        input.addEventListener('change', handleSettingInput);
    });
    root.querySelectorAll('[data-codex-aux-action="export"]').forEach(button => {
        button.addEventListener('click', () => {
            exportTaskSnapshot().catch(error => setStatus(error.message, true));
        });
    });
    root.querySelectorAll('[data-codex-aux-action="fix-latest"]').forEach(button => {
        button.addEventListener('click', () => {
            repairLatestAssistantMessage().catch(error => setStatus(error.message, true));
        });
    });
    root.querySelectorAll('[data-codex-aux-action="open-panel"]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openFloatingPanel().catch(error => setStatus(error.message, true));
        });
    });
    root.querySelectorAll('[data-codex-aux-action="close-panel"]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            closeFloatingPanel();
        });
    });
    root.querySelectorAll('[data-codex-aux-action="reset-panel"]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault();
            const settings = getSettings();
            settings.panelLeft = null;
            settings.panelTop = null;
            saveSettingsDebounced();
            applyPanelPosition();
        });
    });
    if (root.dataset) root.dataset.codexAuxBound = '1';
}

function getPanel() {
    return document.getElementById(panelId);
}

function clampPanelPosition(left, top, root = getPanel()) {
    const margin = 8;
    const rect = root?.getBoundingClientRect();
    const width = rect?.width || 440;
    const height = rect?.height || 560;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
        left: Math.min(Math.max(margin, left), maxLeft),
        top: Math.min(Math.max(margin, top), maxTop),
    };
}

function applyPanelPosition() {
    const root = getPanel();
    if (!root) return;
    const settings = getSettings();
    if (window.innerWidth <= 640) {
        root.style.left = '';
        root.style.top = '';
        root.style.right = '';
        root.style.bottom = '';
        return;
    }
    if (Number.isFinite(Number(settings.panelLeft)) && Number.isFinite(Number(settings.panelTop))) {
        const next = clampPanelPosition(Number(settings.panelLeft), Number(settings.panelTop), root);
        settings.panelLeft = next.left;
        settings.panelTop = next.top;
        root.style.left = `${next.left}px`;
        root.style.top = `${next.top}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        return;
    }
    root.style.left = '';
    root.style.top = '';
    root.style.right = '';
    root.style.bottom = '';
}

function setupPanelDrag(root) {
    const handle = root?.querySelector('[data-codex-aux-drag]');
    if (!handle || handle.dataset.codexAuxDragBound === '1') return;
    let dragState = null;

    function finishDrag(event) {
        if (!dragState) return;
        root.classList.remove('is-dragging');
        try { handle.releasePointerCapture?.(dragState.pointerId); } catch (_) {}
        dragState = null;
        saveSettingsDebounced();
        saveStateFile().catch(error => setStatus(error.message, true));
        event?.preventDefault?.();
    }

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (event.target.closest('button, input, select, textarea, a')) return;
        const rect = root.getBoundingClientRect();
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
        };
        root.classList.add('is-dragging');
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const next = clampPanelPosition(
            dragState.startLeft + event.clientX - dragState.startX,
            dragState.startTop + event.clientY - dragState.startY,
            root,
        );
        const settings = getSettings();
        settings.panelLeft = next.left;
        settings.panelTop = next.top;
        root.style.left = `${next.left}px`;
        root.style.top = `${next.top}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        event.preventDefault();
    });

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.dataset.codexAuxDragBound = '1';
}

async function ensurePanel() {
    const existing = getPanel();
    if (existing) return existing;
    if (panelLoadPromise) return panelLoadPromise;
    panelLoadPromise = (async () => {
        const response = await fetch(settingsUrl);
        if (!response.ok) throw new Error(`failed to load ${settingsUrl}: ${response.status}`);
        const container = document.createElement('div');
        container.innerHTML = (await response.text()).trim();
        const root = container.firstElementChild;
        if (!root) throw new Error('Codex 辅助桥面板模板为空');
        document.body.append(root);
        setupPanelDrag(root);
        bindSettingsUi(root);
        writeSettingsToUi();
        floatingPanelOpen = !!getSettings().panelOpen;
        root.hidden = !floatingPanelOpen;
        root.classList.toggle('is-open', floatingPanelOpen);
        applyPanelPosition();
        updateFloatingButton();
        return root;
    })();
    return panelLoadPromise;
}

function renderInlineSettings() {
    return `
        <div id="${inlineSettingsId}" class="inline-drawer codex-aux-inline-settings">
            <div class="inline-drawer-toggle inline-drawer-header codex-aux-inline-header">
                <div class="codex-aux-inline-title">
                    <b>Codex 辅助桥</b>
                    <span>生图辅助任务</span>
                </div>
                <button class="menu_button" type="button" data-codex-aux-action="open-panel" title="打开 Codex 辅助桥面板">
                    <i class="fa-solid fa-up-right-from-square"></i>
                </button>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content codex-aux-inline-content">
                <div class="codex-aux-inline-row">
                    <label class="checkbox_label codex-aux-toggle">
                        <input type="checkbox" data-codex-aux-setting="enabled">
                        <span>启用辅助桥</span>
                    </label>
                    <span class="codex-aux-status">就绪</span>
                </div>
                <div class="codex-aux-inline-row">
                    <button class="menu_button" type="button" data-codex-aux-action="open-panel">打开控制台</button>
                    <button class="menu_button" type="button" data-codex-aux-action="export">导出任务快照</button>
                    <button class="menu_button" type="button" data-codex-aux-action="fix-latest">修复最新楼层</button>
                </div>
            </div>
        </div>
    `;
}

function ensureInlineSettings() {
    const host = document.getElementById('extensions_settings');
    if (!host || document.getElementById(inlineSettingsId)) return;
    host.insertAdjacentHTML('beforeend', renderInlineSettings());
    const root = document.getElementById(inlineSettingsId);
    if (root) {
        try { toggleDrawer(root, false); } catch (_) {}
        bindSettingsUi(root);
        writeSettingsToUi();
    }
}

function watchExtensionSettingsHost() {
    ensureInlineSettings();
    if (extensionSettingsObserver) return;
    extensionSettingsObserver = new MutationObserver(() => ensureInlineSettings());
    extensionSettingsObserver.observe(document.body, { childList: true, subtree: true });
}

function updateFloatingButton() {
    let button = document.getElementById(floatingButtonId);
    if (!button) {
        button = document.createElement('button');
        button.id = floatingButtonId;
        button.type = 'button';
        button.className = 'codex-aux-fab';
        button.title = 'Codex 辅助桥';
        button.setAttribute('aria-label', 'Codex 辅助桥');
        button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>辅助</span>';
        button.addEventListener('click', toggleFloatingPanel);
        document.body.append(button);
    }
    button.classList.toggle('active', floatingPanelOpen);
    button.setAttribute('aria-expanded', String(floatingPanelOpen));
}

async function openFloatingPanel() {
    const root = await ensurePanel();
    floatingPanelOpen = true;
    getSettings().panelOpen = true;
    root.hidden = false;
    root.classList.add('is-open');
    applyPanelPosition();
    saveSettingsDebounced();
    updateFloatingButton();
}

function closeFloatingPanel() {
    const root = getPanel();
    floatingPanelOpen = false;
    getSettings().panelOpen = false;
    if (root) {
        root.classList.remove('is-open');
        root.hidden = true;
    }
    saveSettingsDebounced();
    updateFloatingButton();
}

function toggleFloatingPanel() {
    if (floatingPanelOpen) closeFloatingPanel();
    else openFloatingPanel().catch(error => setStatus(error.message, true));
}

function ensureFloatingStatus() {
    if (document.getElementById('codex_aux_floating_status')) return;
    const status = document.createElement('div');
    status.id = 'codex_aux_floating_status';
    status.className = 'codex-aux-floating-status';
    status.textContent = '就绪';
    const button = document.getElementById(floatingButtonId);
    if (button?.parentNode) button.insertAdjacentElement('afterend', status);
    else document.body.append(status);
}

async function loadSettingsUi() {
    await ensurePanel();
    watchExtensionSettingsHost();
    updateFloatingButton();
    ensureFloatingStatus();
    window.addEventListener('resize', applyPanelPosition);
}

function scheduleExport(reason = '') {
    if (!getSettings().enabled) return;
    clearTimeout(exportTimer);
    exportTimer = setTimeout(() => {
        exportTaskSnapshot().catch(error => {
            console.warn('[Codex Aux Bridge] export failed', reason, error);
            setStatus(error.message, true);
        });
    }, 500);
}

window.CODEX_AUX_BRIDGE = {
    getSettings,
    exportTaskSnapshot,
    repairLatestAssistantMessage,
    normalizeMessageFormat,
    openFloatingPanel,
    closeFloatingPanel,
    toggleFloatingPanel,
};

function bindEvent(eventName, handler) {
    if (eventName) {
        eventSource.on(eventName, handler);
    }
}

jQuery(async () => {
    getSettings();
    await loadSettingsUi();
    saveStateFile().catch(error => setStatus(error.message, true));
    scheduleExport('extension-loaded');
    bindEvent(event_types.MESSAGE_RECEIVED, () => scheduleExport('message-received'));
    bindEvent(event_types.CHAT_CHANGED, () => scheduleExport('chat-changed'));
    bindEvent(event_types.MESSAGE_UPDATED, () => scheduleExport('message-updated'));
    bindEvent(event_types.MESSAGE_EDITED, () => scheduleExport('message-edited'));
    bindEvent(event_types.MESSAGE_SWIPED, () => scheduleExport('message-swiped'));
    bindEvent(event_types.APP_READY, () => scheduleExport('app-ready'));
});
