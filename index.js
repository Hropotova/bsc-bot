require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const {walletParserMultiChain, walletParserSingleChain} = require('./options/wallet-parser');
const config = require('./config.js');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, {polling: true});

const app = express();
const PORT = process.env.PORT || 3001;

const userState = {};

function showModeButtons(chatId) {
    const opts = {
        reply_markup: JSON.stringify({
            inline_keyboard: [
                [{text: 'Chain ID', callback_data: 'mode:chain_id'}],
                [{text: 'Active Chains', callback_data: 'mode:active_chains'}],
            ],
        }),
    };
    bot.sendMessage(chatId, 'Select an operation mode:', opts);
}

function buildChainsKeyboard() {
    const entries = Object.entries(config);
    const rows = [];

    for (let i = 0; i < entries.length; i += 2) {
        const row = [];

        const [key1, val1] = entries[i];
        row.push({
            text: val1.chain_name ?? key1.toUpperCase(),
            callback_data: `set_chain:${key1}`,
        });

        if (entries[i + 1]) {
            const [key2, val2] = entries[i + 1];
            row.push({
                text: val2.chain_name ?? key2.toUpperCase(),
                callback_data: `set_chain:${key2}`,
            });
        }

        rows.push(row);
    }

    return {
        reply_markup: JSON.stringify({
            inline_keyboard: rows,
        }),
    };
}

bot.onText(/\/start/, (msg) => showModeButtons(msg.chat.id));
bot.onText(/\/change/, (msg) => showModeButtons(msg.chat.id));

bot.on('callback_query', async ({message, data, id}) => {
    try {
        const chatId = message.chat.id;

        if (data === 'mode:chain_id') {
            userState[chatId] = {mode: 'chain_id'};
            const chainKb = buildChainsKeyboard();
            return bot.sendMessage(chatId, 'Select a chain:', chainKb);
        }

        if (data === 'mode:active_chains') {
            userState[chatId] = {mode: 'active_chains'};
            return bot.sendMessage(chatId, 'Send one or more wallet addresses:');
        }

        if (data.startsWith('set_chain:')) {
            const chainKey = data.split(':')[1];
            if (!config[chainKey]) {
                return bot.sendMessage(
                    chatId,
                    'Unknown chain ID. Available options: ' + Object.keys(config).join(', ')
                );
            }

            userState[chatId] = {mode: 'chain_id', chain: chainKey};
            const displayName = config[chainKey].chain_name ?? chainKey.toUpperCase();
            return bot.sendMessage(
                chatId,
                `Chain ID set to '${displayName}'. Send one or more wallet addresses:`
            );
        }

        if (id) bot.answerCallbackQuery(id);
    } catch (e) {
        console.error('callback_query error:', e);
    }
});

bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text.startsWith('/start') || text.startsWith('/change')) {
        return;
    }

    const state = userState[chatId];
    if (!state) {
        return showModeButtons(chatId);
    }

    try {
        if (state.mode === 'chain_id') {
            if (!state.chain) {
                const chainKb = buildChainsKeyboard();
                return bot.sendMessage(chatId, 'Select a chain:', chainKb);
            }

            await walletParserSingleChain(text, bot, chatId, state.chain);
            delete userState[chatId];
            return showModeButtons(chatId);
        }

        if (state.mode === 'active_chains') {
            await walletParserMultiChain(text, bot, chatId);
            delete userState[chatId];
            return showModeButtons(chatId);
        }
    } catch (err) {
        console.error('Error handling message:', err);
        await bot.sendMessage(chatId, 'An error occurred. Try again later.');
        delete userState[chatId];
        return showModeButtons(chatId);
    }
});

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});
