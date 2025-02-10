require('dotenv').config();
const fs = require('fs');
const ExcelJS = require('exceljs');
const Web3 = require('web3');
const Bottleneck = require('bottleneck');

const {
    getSolanaPrice,
    getTokenBalances,
    getHistoryTrades,
    getTrades,
} = require('../api');

const web3 = new Web3(process.env.PROVIDER);

const limiter = new Bottleneck({
    minTime: 200,
    maxConcurrent: 1,
});

const walletParser = async (addresses, bot, chatId) => {
    const splitAddresses = addresses.split('\n');

    console.log('ADDRESSES — ', splitAddresses);

    const bnbPrice = await getSolanaPrice();

    for (const address of splitAddresses) {
        console.log('ADDRESS — ', address);

        try {
            let results = [];

            const transactionsHistory = await getTrades(address);

            if (transactionsHistory.length === 0 || transactionsHistory.length > Number(process.env.COUNT_TRADE)) {
                continue;
            }

            console.log('COUNT TRADES — ', transactionsHistory.length);

            const tokenBalances = await getTokenBalances(address);

            console.log('TOKEN BALANCE — ', tokenBalances);

            const tokenSummary = {};

            await Promise.all(
                transactionsHistory.map((transaction) =>
                    limiter.schedule(async () => {

                        const {quote, base} = transaction;
                        const transactionCheck = await web3.eth.getTransaction(transaction.tx_hash);
                        const receipt = await web3.eth.getTransactionReceipt(transaction.tx_hash);
                        const methodId = transactionCheck.input.slice(0, 10);
                        const checkTransfer = (methodId === '0xa9059cbb');

                        let transfer;
                        if (checkTransfer) {
                            if (receipt.from.toUpperCase() === address.toUpperCase()) {
                                transfer = 'out';
                            } else if (receipt.to.toUpperCase() === address.toUpperCase()) {
                                transfer = 'in';
                            }
                        } else {
                            transfer = false;
                        }

                        const isSol = (token) => token.symbol === 'wbnb';
                        const isReceived = (token) => token.ui_change_amount > 0;
                        const isSpent = (token) => token.ui_change_amount < 0;

                        const solIsQuote = isSol(quote);
                        const solIsBase = isSol(base);

                        if (!solIsQuote && !solIsBase) {
                            const quoteInSol = (quote.ui_amount * (quote.nearest_price)) / bnbPrice;
                            const baseInSol = (base.ui_amount * (base.nearest_price)) / bnbPrice;

                            const fromToken = base.type_swap === 'from' ? base : quote;
                            const toToken = base.type_swap === 'to' ? base : quote;

                            const fromTokenAddress = fromToken.address;
                            const fromTokenSymbol = fromToken.symbol;
                            const toTokenAddress = toToken.address;
                            const toTokenSymbol = toToken.symbol;

                            if (!tokenSummary[fromTokenAddress]) {
                                tokenSummary[fromTokenAddress] = {
                                    tokenSymbol: fromTokenSymbol,
                                    received: 0,
                                    spent: 0,
                                    profit: 0,
                                    transactions: 0,
                                    swapToken: 0,
                                };
                            }
                            if (!tokenSummary[toTokenAddress]) {
                                tokenSummary[toTokenAddress] = {
                                    tokenSymbol: toTokenSymbol,
                                    received: 0,
                                    spent: 0,
                                    profit: 0,
                                    transactions: 0,
                                    swapToken: 0,
                                };
                            }

                            tokenSummary[fromTokenAddress].spent += fromToken === base ? baseInSol : quoteInSol;
                            tokenSummary[toTokenAddress].received += toToken === base ? baseInSol : quoteInSol;
                            tokenSummary[toTokenAddress].spent += toToken === base ? baseInSol : quoteInSol;
                            tokenSummary[fromTokenAddress].transactions += 1;
                            tokenSummary[toTokenAddress].transactions += 1;
                            tokenSummary[fromTokenAddress].swapToken += fromToken === base ? baseInSol : quoteInSol;
                            tokenSummary[fromTokenAddress].profit =
                                tokenSummary[fromTokenAddress].received - tokenSummary[fromTokenAddress].spent;
                            tokenSummary[fromTokenAddress].transfer = transfer;
                            tokenSummary[toTokenAddress].profit =
                                tokenSummary[toTokenAddress].received - tokenSummary[toTokenAddress].spent;
                            tokenSummary[toTokenAddress].transfer = transfer;
                        } else {
                            const tokenAddress = solIsQuote ? base.address : quote.address;
                            const tokenSymbol = solIsQuote ? base.symbol : quote.symbol;
                            const isTransactionReceived = solIsQuote ? isReceived(quote) : isReceived(base);
                            const isTransactionSpent = solIsQuote ? isSpent(quote) : isSpent(base);

                            if (!tokenSummary[tokenAddress]) {
                                tokenSummary[tokenAddress] = {
                                    tokenSymbol,
                                    received: 0,
                                    spent: 0,
                                    profit: 0,
                                    transactions: 0,
                                    swapToken: 0,
                                };
                            }

                            const tokenAmount = solIsQuote ? quote.ui_amount : base.ui_amount;

                            if (isTransactionReceived) {
                                tokenSummary[tokenAddress].received += tokenAmount;
                            } else if (isTransactionSpent) {
                                tokenSummary[tokenAddress].spent += tokenAmount;
                            }

                            tokenSummary[tokenAddress].transactions += 1;
                            tokenSummary[tokenAddress].profit =
                                tokenSummary[tokenAddress].received - tokenSummary[tokenAddress].spent;
                            tokenSummary[tokenAddress].transfer = transfer;
                        }
                    })
                )
            );


            console.log('CALCULATED DATA', tokenSummary)

            for (const token in tokenSummary) {
                const {spent, received, tokenSymbol, swapToken} = tokenSummary[token];
                const profit = received - spent;

                const tokenBalance = tokenBalances.find(i => i.address === token);
                let tokenValue = tokenBalance ? tokenBalance.valueUsd : 0;
                let tradeSymbol

                const trades = await getHistoryTrades(token, 1000000000000000);

                if (trades && trades.length > 0) {
                    if (tokenValue === undefined) {
                        tokenValue = tokenBalance?.uiAmount * trades[0]?.base?.price;
                    }

                    if (!tokenSymbol) {
                        tradeSymbol = trades[0]?.base?.symbol;
                    }

                    const bnbBalance = tokenValue / bnbPrice;

                    const pnl = bnbBalance + (received - spent);

                    console.log(`TOKEN ${tokenSymbol} ${token} PNL — `, pnl);

                    let transfer;

                    if (bnbBalance === 0 && spent > 0 && received === 0) {
                        transfer = true
                    } else if (spent === 0) {
                        transfer = true
                    }

                    results.push({
                        tokenName: tokenSymbol ? tokenSymbol : tradeSymbol,
                        pnl: Number(pnl.toFixed(2)),
                        spent: Number(Math.abs(spent.toFixed(2))),
                        contractAddress: token,
                        transfer: transfer ? 'TRUE' : 'FALSE',
                    });
                }
            }

            results.forEach((i) => {
                if (i.tokenName === '') {
                    delete i
                }
            })

            const calculateAverage = (data) => {
                const sum = data.reduce((acc, val) => acc + val, 0);
                return sum / data.length;
            };

            const calculateStDev = (data, average) => {
                const squareDiffs = data.map(value => Math.pow(value - average, 2));
                return Math.sqrt(calculateAverage(squareDiffs));
            };

            const pnlValues = results.map(result => parseFloat(result.pnl));
            const averagePnL = calculateAverage(pnlValues);
            const stDevPnL = calculateStDev(pnlValues, averagePnL);

            results.forEach(result => {
                const zScore = (parseFloat(result.pnl) - averagePnL) / stDevPnL;
                const winRate = parseFloat(result.pnl) > 0.1;

                result.zScore = Number(zScore.toFixed(2))
                result.winRate = winRate ? 'TRUE' : 'FALSE';
            });

            const removeTokensEnv = process.env.REMOVE_TOKENS;
            if (removeTokensEnv) {
                const removeTokens = removeTokensEnv.split(',').map(token => token.trim().toLowerCase());
                results = results.filter(result => !removeTokens.includes(result.contractAddress.toLowerCase()));
            }

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Results');


            worksheet.columns = [
                {header: 'Token', key: 'tokenName', width: 15},
                {header: 'PnL', key: 'pnl', width: 10},
                {header: 'Spent, Ξ', key: 'spent', width: 10},
                {header: 'Transfer', key: 'transfer', width: 10},
                {header: 'Contract address', key: 'contractAddress', width: 70},
                {header: 'Z-Score', key: 'zScore', width: 10},
                {header: 'Win Rate', key: 'winRate', width: 10},
                // {header: 'Buy Time', key: 'buyTime', width: 10},
            ];

            const greenFill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: {argb: 'FFD7C7FF'},
            };

            const redFill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: {argb: 'FFF5E9E8'},
            };

            const trueFill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: {argb: 'FFF2A6A3'},
            };

            const falseFill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: {argb: 'FF83B38B'},
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
                {state: 'frozen', ySplit: 1},
            ];

            results.sort((a, b) => b.pnl - a.pnl);

            results.forEach((result) => {
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

            let winCount = 0;
            let totalPnl = 0;
            let totalSlicePnl = 0;
            let countForAverage = 0;
            let countForSliceAverage = 0;

            results.forEach((result) => {
                if (result.transfer !== 'TRUE') {
                    if (parseFloat(result.pnl) > 0.08) {
                        winCount += 1;
                    }
                    totalPnl += parseFloat(result.pnl);
                    countForAverage += 1;
                }
            });

            if (results.length > process.env.COUNT_FIRST_ADDRESSSES) {
                results.slice(0, process.env.COUNT_FIRST_ADDRESSSES).forEach((result) => {
                    if (result.transfer !== 'TRUE') {
                        totalSlicePnl += parseFloat(result.pnl);
                        countForSliceAverage += 1;
                    }
                });
            }
            const winPercentage = countForAverage > 0 ? (winCount / countForAverage) * 100 : 0;
            const pnlAverage = countForAverage > 0 ? totalPnl / countForAverage : 0;
            const pnlSliceAverage = countForSliceAverage > 0 ? totalSlicePnl / countForSliceAverage : 0;

            console.log(`PNL AVERAGE ${address} — `, pnlAverage)
            console.log(`WIN RATE ${address} — `, winPercentage)

            if ((pnlAverage >= process.env.AVARAGE_PNL) && winPercentage >= process.env.WIN_RATE) {
                const path = `${winPercentage.toFixed(0)}% ${pnlAverage.toFixed(2)}bnb - ${address}.xlsx`;
                await workbook.xlsx.writeFile(path);

                const options = {
                    caption: `\`${address}\``,
                    parse_mode: 'MarkdownV2',
                };

                if (fs.existsSync(path)) {
                    bot.sendDocument(chatId, path, options)
                        .then(() => {
                            fs.unlinkSync(path);
                            const options = {
                                reply_markup: JSON.stringify({
                                    inline_keyboard: [
                                        [{text: 'Wallet address', callback_data: 'option1'}],
                                        [{text: 'Contract address', callback_data: 'option2'}],
                                        [{text: 'Token holders', callback_data: 'option3'}],
                                    ],
                                }),
                            };
                            bot.sendMessage(chatId, 'Choose an option:', options);
                        });
                }
            }
        } catch (error) {
            console.log(error)
            console.error(`Помилка при обробці гаманця: ${address}`);
        }
    }
};

module.exports = {walletParser};
