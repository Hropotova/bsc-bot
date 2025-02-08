const fs = require('fs');
const ExcelJS = require('exceljs');

const {getSolanaPrice, getTokenBalances, getHistoryTrades, getTokenHistoryTransactions, getHistoryTokenPrice} = require('../api');

const contractSingleDateParser = async (dates, bot, chatId, addressState) => {
    try {
        const date = new Date(dates);
        const unixTime = Math.floor(date.getTime() / 1000);

        const solanaPrice = await getSolanaPrice();

        const trades = await getHistoryTrades(addressState, unixTime);

        const filteredTrades = trades
            .filter(trade => trade?.blockUnixTime < unixTime)
            .filter(trade => trade?.side === 'buy')

        const buyers = new Set();

        let symbol = filteredTrades[0].to.symbol;

        filteredTrades.map((trade) => {
            buyers.add(trade?.owner);
        })

        let results = [];
        for (const address of Array.from(buyers)) {

            let transactionsHistory = [];
            let tokenBalances = [];
            try {
                transactionsHistory = await getTokenHistoryTransactions(address);
            } catch (error) {
                console.error(`Error fetching transaction history for address ${address}:`, error);
                continue;
            }

            try {
                tokenBalances = await getTokenBalances(address);
            } catch (error) {
                console.error(`Error fetching token balances for address ${address}:`, error);
                continue;
            }

            if (transactionsHistory.length === 0 || transactionsHistory.length > Number(process.env.COUNT_TRADE)) {
                continue;
            }

            if (transactionsHistory && tokenBalances) {
                const tokenSummary = {};
                await Promise.all(transactionsHistory.reverse().map(async transaction => {
                    let buyAmount;
                    let sellAmount;
                    let tokenSymbol;
                    let transactionLog = transaction.balanceChange;

                    if (transactionLog.length <= 3 && transactionLog[transactionLog.length - 1].decimals !== 0) {
                        if (transactionLog.length === 2) {
                            buyAmount = transactionLog[1];
                            sellAmount = transactionLog[0].amount / Math.pow(10, 9);
                            tokenSymbol = buyAmount.symbol;
                        } else if (transactionLog.length === 3) {
                            const stableCoins = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'So11111111111111111111111111111111111111112'];
                            for (const i of transactionLog) {
                                if (i.symbol === 'wbnb' && i.amount < 0) {
                                    for (const i of transactionLog) {
                                        if (i.amount > 0 && !stableCoins.includes(i.address)) {
                                            buyAmount = i;
                                            let date = new Date(transaction.blockTime);
                                            let unixTime = date.getTime() / 1000;
                                            tokenSymbol = buyAmount.symbol;
                                            const tokenPriceUSD = await getHistoryTokenPrice(buyAmount.address, unixTime);
                                            const received = (buyAmount.amount / Math.pow(10, buyAmount.decimals) * tokenPriceUSD) / solanaPrice;
                                            sellAmount = received * -1;
                                        }
                                    }
                                } else if (i.symbol === 'wbnb' && i.amount > 0) {
                                    for (const i of transactionLog) {
                                        if (i.amount < 0 && !stableCoins.includes(i.address)) {
                                            buyAmount = i;
                                            let date = new Date(transaction.blockTime);
                                            let unixTime = date.getTime() / 1000;
                                            tokenSymbol = buyAmount.symbol;
                                            const tokenPriceUSD = await getHistoryTokenPrice(buyAmount.address, unixTime);
                                            sellAmount = (buyAmount.amount / Math.pow(10, buyAmount.decimals) * tokenPriceUSD) / solanaPrice;
                                        }
                                    }
                                }
                            }
                        }

                        if (buyAmount) {
                            let transfer = false;
                            if (transaction.mainAction === 'send') {
                                transfer = true
                            }
                            if (!tokenSummary[buyAmount?.address]) {
                                tokenSummary[buyAmount?.address] = {
                                    received: 0,
                                    spent: 0,
                                    profit: 0,
                                    tokenSymbol,
                                    transfer
                                };
                            }

                            if (transaction.balanceChange[0].amount < 0) {
                                tokenSummary[buyAmount?.address].spent += sellAmount;
                            } else {
                                tokenSummary[buyAmount?.address].received += sellAmount;
                            }

                            tokenSummary[buyAmount?.address].profit = tokenSummary[buyAmount?.address].received + tokenSummary[buyAmount?.address].spent;
                        }
                    }
                }));

                let profit;
                let spent;
                let received;
                let tokenSymbol;
                let transfer = false;
                if (tokenSummary[addressState]) {
                    spent = tokenSummary[addressState].spent
                    received = tokenSummary[addressState].received
                    transfer = tokenSummary[addressState].transfer
                    tokenSymbol = tokenSummary[addressState].tokenSymbol
                    profit = received + spent;
                } else {
                    const trade = filteredTrades.findLast(i => i.owner === address && i.side === 'buy')
                    spent = trade.from.amount / Math.pow(10, 9)
                    received = 0
                    tokenSymbol = trade.to.symbol
                    profit = received + spent;
                }

                const tokenBalance = tokenBalances.find(i => i.address === addressState);
                const tokenValue = tokenBalance ? tokenBalance.valueUsd : 0;

                const tokenBalanceInSOL = tokenValue / solanaPrice;
                const pnl = tokenBalanceInSOL + profit;

                let isTransfer;

                if ((transfer) || Number(pnl.toFixed(2)) === 0 && Number(Math.abs(spent.toFixed(2))) === 0) {
                    isTransfer = true
                }

                results.push({
                    tokenName: address,
                    pnl: Number(pnl.toFixed(2)),
                    spent: Number(Math.abs(spent.toFixed(2))),
                    transfer: transfer ? 'TRUE' : 'FALSE',
                });
            }
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Results');

        worksheet.columns = [
            {header: 'Wallet', key: 'tokenName', width: 80},
            {header: 'PnL', key: 'pnl', width: 20},
            {header: 'Spent, Ξ', key: 'spent', width: 20},
            {header: 'Transfer', key: 'transfer', width: 20},
        ];

        const greenFill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {argb: 'FFD7C7FF'}
        };

        const redFill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {argb: 'FFF5E9E8'}
        };

        const trueFill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {argb: 'FFF2A6A3'}
        };

        const falseFill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {argb: 'FF83B38B'}
        };

        worksheet.getRow(1).eachCell((cell, colNumber) => {
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: {argb: 'FFBFBFBF'},
            };

            cell.font = {
                name: 'Calibri (Body)',
                size: 14,
                family: 2,
            };

            if (colNumber === 2) {
                cell.fill = greenFill;
            } else if (colNumber === 3) {
                cell.fill = redFill;
            }
        });

        const borderStyle = {
            top: {style: 'thin', color: {argb: 'FFBFBFBF'}},
            left: {style: 'thin', color: {argb: 'FFBFBFBF'}},
            bottom: {style: 'thin', color: {argb: 'FFBFBFBF'}},
            right: {style: 'thin', color: {argb: 'FFBFBFBF'}},
        };

        worksheet.views = [
            {state: 'frozen', ySplit: 1}
        ];

        results.sort((a, b) => b.pnl - a.pnl);

        results.forEach((result, index) => {
            const row = worksheet.addRow(result);
            row.eachCell((cell, colNumber) => {
                cell.border = borderStyle;
                cell.font = {
                    name: 'Calibri (Body)',
                    size: 14,
                    family: 2,
                };

                if (colNumber === 2) {
                    cell.fill = greenFill;
                } else if (colNumber === 3) {
                    cell.fill = redFill;
                }

                if (colNumber === 4) {
                    cell.fill = result.transfer === 'TRUE' ? trueFill : falseFill;
                }
            });
        });

        const path = `$${symbol} single - ${addressState}.xlsx`;

        await workbook.xlsx.writeFile(path);

        if (fs.existsSync(path)) {
            bot.sendDocument(chatId, path)
                .then(() => {
                    fs.unlinkSync(path);
                    const options = {
                        reply_markup: JSON.stringify({
                            inline_keyboard: [
                                [{text: 'Wallet address', callback_data: 'option1'}],
                                [{text: 'Contract address', callback_data: 'option2'}],
                                [{text: 'Token holders', callback_data: 'option3'}],
                            ]
                        })
                    };
                    bot.sendMessage(chatId, 'Choose an option:', options);
                });
        }
    } catch (error) {
        console.error(`Помилка при обробці гаманця: ${addressState}`);
        console.error(error);
    }
};

module.exports = {contractSingleDateParser};
