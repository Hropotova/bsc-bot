require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const {walletParser} = require('./options/walletParser');
const {walletsParser} = require('./options/walletsParser');
const {contractSingleDateParser} = require('./options/contractSingleDateParser');
const {contractRangeDateParser} = require("./options/contractRangeDateParser");

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
                [{text: 'Contract address', callback_data: 'option2'}],
                [{text: 'Wallet addresses', callback_data: 'option3'}],
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
    } else if (data === 'option2') {
        bot.sendMessage(chatId, 'You chose contract address. Please send me a contract address.');
    } else if (data === 'option3') {
        bot.sendMessage(chatId, 'You chose wallet addresses. Please send me a wallet addresses.');
    } else if (data === 'single_date') {
        bot.sendMessage(chatId, 'Please enter the date in format endDate: 2023-09-03T00:00:00Z.');
    } else if (data === 'range_date') {
        bot.sendMessage(chatId, 'Please enter the date in format startDate/endDate: 2023-09-03T00:00:00Z/2023-09-04T00:00:00Z.');
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
        } else if (userState[chatId] === 'single_date') {
            await contractSingleDateParser(message, bot, chatId, contractState);
        } else if (userState[chatId] === 'range_date') {
            await contractRangeDateParser(message, bot, chatId, contractState);
        } else if (userState[chatId] === 'option3') {
            await walletsParser(message, bot, chatId);
        }

    } catch (error) {
        console.error('An error occurred:', error);
        bot.sendMessage(msg.chat.id, 'An error occurred. Please try again later.');
        const options = {
            reply_markup: JSON.stringify({
                inline_keyboard: [
                    [{text: 'Wallet address', callback_data: 'option1'}],
                    [{text: 'Contract address', callback_data: 'option2'}],
                    [{text: 'Wallet addresses', callback_data: 'option3'}],
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
