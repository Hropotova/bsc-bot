require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const {walletParser} = require('./services/walletParser');

const app = express();
const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, {polling: true});
const PORT = process.env.PORT || 3000;

const userState = {};
let contractState = '';

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const options = {
        reply_markup: JSON.stringify({
            inline_keyboard: [
                [{text: 'Wallet address', callback_data: 'option1'}],
            ]
        })
    };
    bot.sendMessage(chatId, 'Choose an option:', options);
});

bot.on('callback_query', (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    userState[chatId] = data;

    if (data === 'option1') {
        bot.sendMessage(chatId, 'You chose wallet address. Please send me a wallet address.');
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    try {

        if (msg.text.startsWith('/start')) {
            return;
        }

        const message = msg.text.trim();

        if (userState[chatId] === 'option1') {
            await walletParser(message, bot, chatId)
        } else if (userState[chatId] === 'option2') {
            const options = {
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [{text: 'Single date', callback_data: 'single_date'}],
                        [{text: 'Range date', callback_data: 'range_date'}],
                    ]
                })
            };
            bot.sendMessage(chatId, 'Choose a date:', options);

            contractState = message;
        }

    } catch (error) {
        console.error('An error occurred:', error);
        bot.sendMessage(msg.chat.id, 'An error occurred. Please try again later.');
        const options = {
            reply_markup: JSON.stringify({
                inline_keyboard: [
                    [{text: 'Wallet address', callback_data: 'option1'}],
                ]
            })
        };
        bot.sendMessage(chatId, 'Choose an option:', options);
    }
});

bot.on('polling_error', (error) => {
    console.error(error.code);
});

app.listen(PORT, function () {
    console.log(`Telegram bot is listening on port ${PORT}`);
});
