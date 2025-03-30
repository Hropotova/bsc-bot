require('dotenv').config();
const fs = require('fs');
const ExcelJS = require('exceljs');
const axios = require('axios');

const walletParser = async (addresses, bot, chatId) => {
    const splitAddresses = addresses.split('\n');
    const API_KEY = process.env.MORALIS_API_KEY;

    for (const address of splitAddresses) {
        try {
            let cursor = null;
            let allSwaps = [];

            while (true) {
                const url = `https://deep-index.moralis.io/api/v2.2/wallets/${address}/swaps?chain=bsc&order=DESC${cursor ? `&cursor=${cursor}` : ''}`;
                const response = await axios.get(url, {
                    headers: {
                        accept: 'application/json',
                        'X-API-Key': API_KEY
                    }
                });

                const data = response.data;
                const swaps = data.result || [];
                allSwaps.push(...swaps);

                if (!data.cursor || swaps.length < 100) break;
                cursor = data.cursor;
            }

            const tokenStats = {};
            for (const swap of allSwaps) {
                const { bought, sold } = swap;
                if (!bought || !sold) continue;

                const boughtSymbol = bought.symbol;
                const soldSymbol = sold.symbol;
                const boughtAddress = bought.address;
                const soldAddress = sold.address;

                if (soldSymbol === 'WBNB') {
                    const token = boughtSymbol;
                    if (!tokenStats[token]) {
                        tokenStats[token] = {
                            boughtAmount: 0,
                            soldAmount: 0,
                            wbnbSpent: 0,
                            wbnbReceived: 0,
                            contractAddress: boughtAddress,
                            balance: 0
                        };
                    }
                    tokenStats[token].boughtAmount += parseFloat(bought.amount);
                    tokenStats[token].wbnbSpent += Math.abs(parseFloat(sold.amount));
                }

                if (boughtSymbol === 'WBNB') {
                    const token = soldSymbol;
                    if (!tokenStats[token]) {
                        tokenStats[token] = {
                            boughtAmount: 0,
                            soldAmount: 0,
                            wbnbSpent: 0,
                            wbnbReceived: 0,
                            contractAddress: soldAddress,
                            balance: 0
                        };
                    }
                    tokenStats[token].soldAmount += Math.abs(parseFloat(sold.amount));
                    tokenStats[token].wbnbReceived += parseFloat(bought.amount);
                }
            }

            // Отримати баланси токенів
            const balanceResponse = await axios.get(
                `https://deep-index.moralis.io/api/v2.2/wallets/${address}/tokens?chain=bsc`,
                {
                    headers: {
                        accept: 'application/json',
                        'X-API-Key': API_KEY
                    }
                }
            );
            const balances = balanceResponse.data.result;
            const bnbPrice = balances.find(t => t.symbol === 'BNB')?.usd_price || 600;

            for (const token of balances) {
                const symbol = token.symbol;
                if (tokenStats[symbol]) {
                    const usdValue = token.usd_value || 0;
                    const wbnbValue = usdValue / bnbPrice;
                    tokenStats[symbol].balance = wbnbValue;
                }
            }

            const results = [];

            for (const [symbol, stats] of Object.entries(tokenStats)) {
                const pnl = stats.balance + (stats.wbnbReceived - stats.wbnbSpent);

                results.push({
                    tokenName: symbol,
                    pnl: Number(pnl.toFixed(4)),
                    spent: Number(stats.wbnbSpent.toFixed(4)),
                    contractAddress: stats.contractAddress,
                    transfer: 'FALSE',
                });
            }

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Results');

            worksheet.columns = [
                { header: 'Token', key: 'tokenName', width: 15 },
                { header: 'PnL', key: 'pnl', width: 15 },
                { header: 'Spent, Ξ', key: 'spent', width: 15 },
                { header: 'Transfer', key: 'transfer', width: 10 },
                { header: 'Contract address', key: 'contractAddress', width: 70 }
            ];

            const greenFill = {
                type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD7C7FF' }
            };
            const redFill = {
                type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5E9E8' }
            };
            const trueFill = {
                type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2A6A3' }
            };
            const falseFill = {
                type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF83B38B' }
            };

            worksheet.getRow(1).eachCell((cell, colNumber) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } };
                cell.font = { name: 'Calibri (Body)', size: 14, family: 2 };
                if (colNumber === 2) cell.fill = greenFill;
                else if (colNumber === 3) cell.fill = redFill;
            });

            const borderStyle = {
                top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
                left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
                bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
                right: { style: 'thin', color: { argb: 'FFBFBFBF' } }
            };

            worksheet.views = [{ state: 'frozen', ySplit: 1 }];
            results.sort((a, b) => b.pnl - a.pnl);

            results.forEach((result) => {
                const row = worksheet.addRow(result);
                row.eachCell((cell, colNumber) => {
                    cell.border = borderStyle;
                    cell.font = { name: 'Calibri (Body)', size: 14, family: 2 };
                    if (colNumber === 2) cell.fill = greenFill;
                    else if (colNumber === 3) cell.fill = redFill;
                    if (colNumber === 4) cell.fill = result.transfer === 'TRUE' ? trueFill : falseFill;
                });
            });

            const filePath = `${address}.xlsx`;
            await workbook.xlsx.writeFile(filePath);

            const options = {
                caption: `\`${address}\``,
                parse_mode: 'MarkdownV2',
            };


            if (fs.existsSync(filePath)) {
                bot.sendDocument(chatId, filePath, options)
                    .then(() => {
                        fs.unlinkSync(filePath);
                        const options = {
                            reply_markup: JSON.stringify({
                                inline_keyboard: [
                                    [{text: 'Wallet address', callback_data: 'option1'}],
                                ]
                            })
                        };
                        bot.sendMessage(chatId, 'Choose an option:', options);
                    });
            }
        } catch (error) {
            console.error(`Помилка при обробці ${address}:`, error.message);
        }
    }
};

module.exports = { walletParser };