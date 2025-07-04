require('dotenv').config();
const fs = require('fs');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const {walletParserMultiChain, walletParserSingleChain} = require('./options/wallet-parser');
const config = require('./config.js');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, {polling: true});

const app = express();
const PORT = process.env.PORT || 3000;

const userState = {};

function showModeButtons(chatId) {
    const opts = {
        reply_markup: JSON.stringify({
            inline_keyboard: [
                [{text: 'Chain ID', callback_data: 'chain_id'}],
                [{text: 'Active Chains', callback_data: 'active_chains'}],
            ]
        })
    };
    bot.sendMessage(chatId, 'Please select an operation mode:', opts);
}

bot.onText(/\/start/, msg => showModeButtons(msg.chat.id));
bot.onText(/\/change/, msg => showModeButtons(msg.chat.id));

bot.on('callback_query', async ({message, data}) => {
    const chatId = message.chat.id;

    if (data === 'chain_id') {
        userState[chatId] = {mode: 'chain_id'};
        return bot.sendMessage(chatId, 'Enter the chain ID (e.g., bsc, eth, base, avalanche):');
    }

    if (data === 'active_chains') {
        userState[chatId] = {mode: 'active_chains'};
        return bot.sendMessage(chatId, 'Now send one or more wallet addresses:');
    }
});

bot.on('text', async msg => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text.startsWith('/start') || text.startsWith('/change')) {
        return;
    }

    const state = userState[chatId];
    if (!state) {
        return showModeButtons(chatId);
    }

    try {
        if (state.mode === 'chain_id' && !state.chain) {
            const chainKey = text.toLowerCase();
            if (!config[chainKey]) {
                return bot.sendMessage(
                    chatId,
                    'Unknown chain ID. Available options: ' + Object.keys(config).join(', ')
                );
            }
            state.chain = chainKey;
            return bot.sendMessage(
                chatId,
                `Chain ID set to '${chainKey}'. Now send one or more wallet addresses:`
            );
        }

        if (state.mode === 'chain_id' && state.chain) {
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
        await bot.sendMessage(chatId, 'An error occurred. Please try again later.');
        delete userState[chatId];
        showModeButtons(chatId);
    }
});

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});
