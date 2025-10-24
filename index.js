require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const {walletParserMultiChain, walletParserSingleChain} = require('./options/analyzer');
const {processTokenContract} = require('./options/sourcer');
const config = require('./config.js');

if (!process.env.TELEGRAM_TOKEN) {
    console.error('TELEGRAM_TOKEN is missing in .env');
    process.exit(1);
}
const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, {polling: true});

const app = express();
const PORT = process.env.PORT || 3001;

const ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const isEvmAddress = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s || '').trim());

function extractAddresses(text) {
    if (!text) return [];
    const unique = new Set((text.match(ADDRESS_RE) || []).map(a => a.toLowerCase()));
    return Array.from(unique);
}

function buildChainsKeyboard() {
    const entries = Object.entries(config);
    const rows = [];
    for (let i = 0; i < entries.length; i += 2) {
        const row = [];
        const [k1, v1] = entries[i];
        row.push({text: v1.chain_name ?? k1.toUpperCase(), callback_data: `chain:${k1}`});
        if (entries[i + 1]) {
            const [k2, v2] = entries[i + 1];
            row.push({text: v2.chain_name ?? k2.toUpperCase(), callback_data: `chain:${k2}`});
        }
        rows.push(row);
    }
    return {reply_markup: {inline_keyboard: rows}};
}

function showRootMenu(chatId) {
    return bot.sendMessage(chatId, 'Choose a mode:', {
        reply_markup: {
            inline_keyboard: [
                [{text: 'Analyzer', callback_data: 'mode:analyzer'}],
                [{text: 'Sourcer', callback_data: 'mode:sourcer'}],
            ],
        },
    });
}

function showAnalyzerMenu(chatId) {
    return bot.sendMessage(chatId, 'Analyzer: select operation:', {
        reply_markup: {
            inline_keyboard: [
                [{text: 'Chain ID', callback_data: 'analyzer:chain_id'}],
                [{text: 'Active Chains', callback_data: 'analyzer:active_chains'}],
                [{text: '⬅️ Back', callback_data: 'back:root'}],
            ],
        },
    });
}

function showChainsForAnalyzer(chatId) {
    const kb = buildChainsKeyboard();

    kb.reply_markup.inline_keyboard.push([{text: '⬅️ Back', callback_data: 'back:analyzer'}]);
    return bot.sendMessage(chatId, 'Select a chain:', kb);
}

function showChainsForSourcer(chatId) {
    const kb = buildChainsKeyboard();
    kb.reply_markup.inline_keyboard.push([{text: '⬅️ Back', callback_data: 'back:root'}]);
    return bot.sendMessage(chatId, 'Sourcer: select a chain for token contract:', kb);
}

const userState = new Map();

const setState = (chatId, part) => {
    const cur = userState.get(chatId) || {};
    userState.set(chatId, {...cur, ...part, expiresAt: Date.now() + 15 * 60 * 1000});
};
const getState = (chatId) => {
    const s = userState.get(chatId);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
        userState.delete(chatId);
        return null;
    }
    return s;
};
const clearState = (chatId) => userState.delete(chatId);

bot.onText(/\/start/, (msg) => showRootMenu(msg.chat.id));
bot.onText(/\/change/, (msg) => showRootMenu(msg.chat.id));

bot.on('callback_query', async (cq) => {
    const {message, data, id} = cq;
    const chatId = message.chat.id;
    try {
        await bot.answerCallbackQuery(id);

        if (data === 'back:root') {
            clearState(chatId);
            return showRootMenu(chatId);
        }
        if (data === 'back:analyzer') {
            setState(chatId, {section: 'analyzer', mode: null, chain: null});
            return showAnalyzerMenu(chatId);
        }

        if (data === 'mode:analyzer') {
            setState(chatId, {section: 'analyzer', mode: null, chain: null});
            return showAnalyzerMenu(chatId);
        }
        if (data === 'mode:sourcer') {
            setState(chatId, {section: 'sourcer', chain: null});
            return showChainsForSourcer(chatId);
        }

        if (data === 'analyzer:chain_id') {
            setState(chatId, {section: 'analyzer', mode: 'chain_id', chain: null});
            return showChainsForAnalyzer(chatId);
        }
        if (data === 'analyzer:active_chains') {
            setState(chatId, {section: 'analyzer', mode: 'active_chains', chain: null});
            return bot.sendMessage(chatId, 'Send one or more wallet addresses:');
        }

        if (data.startsWith('chain:')) {
            const chainKey = data.split(':')[1];
            if (!config[chainKey]) {
                return bot.sendMessage(chatId, 'Unknown chain. Available: ' + Object.keys(config).join(', '));
            }
            const st = getState(chatId) || {};
            const displayName = config[chainKey].chain_name ?? chainKey.toUpperCase();

            if (st.section === 'analyzer') {
                setState(chatId, {chain: chainKey});
                return bot.sendMessage(chatId, `Analyzer → Chain set to '${displayName}'. Send addresses:`);
            }

            if (st.section === 'sourcer') {
                setState(chatId, {chain: chainKey, expecting: 'sourcer_contract'});
                return bot.sendMessage(chatId, `Sourcer → Chain set to '${displayName}'. Now send token **contract address**:`, {parse_mode: 'Markdown'});
            }

            clearState(chatId);
            return showRootMenu(chatId);
        }
    } catch (e) {
        console.error('callback_query error:', e);
    }
});

bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text.startsWith('/start') || text.startsWith('/change')) return;

    const st = getState(chatId);
    if (!st) return showRootMenu(chatId);

    try {
        if (st.section === 'sourcer' && st.expecting === 'sourcer_contract') {
            const contract = text;
            if (!isEvmAddress(contract)) {
                return bot.sendMessage(chatId, 'Send a contract address.');
            }
            await bot.sendChatAction(chatId, 'upload_document');
            await processTokenContract(contract, bot, chatId, st.chain);
            clearState(chatId);
            return showRootMenu(chatId);
        }

        if (st.section === 'analyzer' && st.mode === 'chain_id') {
            if (!st.chain) {
                return showChainsForAnalyzer(chatId);
            }
            const addrs = extractAddresses(text);
            if (addrs.length === 0) {
                return bot.sendMessage(chatId, 'Send at least address.');
            }
            await bot.sendChatAction(chatId, 'typing');
            await walletParserSingleChain(addrs.join('\n'), bot, chatId, st.chain);
            clearState(chatId);
            return showRootMenu(chatId);
        }

        if (st.section === 'analyzer' && st.mode === 'active_chains') {
            const addrs = extractAddresses(text);
            if (addrs.length === 0) {
                return bot.sendMessage(chatId, 'Send at least address.');
            }
            await bot.sendChatAction(chatId, 'typing');
            await walletParserMultiChain(addrs.join('\n'), bot, chatId);
            clearState(chatId);
            return showRootMenu(chatId);
        }

        clearState(chatId);
        return showRootMenu(chatId);
    } catch (err) {
        console.error('Error handling text:', err);
        await bot.sendMessage(chatId, 'An error occurred. Try again later.');
        clearState(chatId);
        return showRootMenu(chatId);
    }
});

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});
