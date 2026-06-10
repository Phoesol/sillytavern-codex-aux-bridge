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

const defaultSettings = {
    enabled: true,
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
    },
    search: {
        enabled: true,
        scope: 'encyclopedia',
        maxQueries: 3,
    },
};

let lastTaskFile = '';
let exportTimer = null;

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
    const element = document.getElementById('codex_aux_status');
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('error', !!error);
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

async function exportTaskSnapshot(targetMessageId = findLatestAssistantMessageId()) {
    const settings = getSettings();
    const info = getCurrentInfo();
    const floors = collectRecentFloors(targetMessageId);
    const now = new Date().toISOString();
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
    $('#codex_aux_bridge_settings [data-codex-aux-setting]').each(function () {
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

function bindSettingsUi() {
    $('#codex_aux_bridge_settings [data-codex-aux-setting]').on('input change', function () {
        setByPath(getSettings(), this.dataset.codexAuxSetting, readValueFromInput(this));
        saveSettingsDebounced();
        saveStateFile().catch(error => setStatus(error.message, true));
    });
    $('#codex_aux_export_task').on('click', () => {
        exportTaskSnapshot().catch(error => setStatus(error.message, true));
    });
    $('#codex_aux_fix_latest').on('click', () => {
        repairLatestAssistantMessage().catch(error => setStatus(error.message, true));
    });
}

async function loadSettingsUi() {
    if ($('#codex_aux_bridge_settings').length) return;
    const html = await (await fetch(settingsUrl)).text();
    $('#extensions_settings').append(html);
    const root = document.getElementById('codex_aux_bridge_settings');
    if (root) toggleDrawer(root, false);
    writeSettingsToUi();
    bindSettingsUi();
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
