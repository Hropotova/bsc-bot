require('dotenv').config();
const fs = require('fs');

const {
    getWalletTokenSwaps,
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getWalletHistory
} = require('../api/moralis');
const {getAllTransactions} = require('../api/scan');
const {checkTransactionHistory} = require('../services/checkTransactionHistory');
const {transactionsFrequency} = require('../services/transactionsFrequency');
const {averageHoldingHours} = require('../services/averageHoldingHours');
const {contracts} = require('../constants/contracts');

const walletParser = async (addresses, bot, chatId) => {
    const splitAddresses = addresses.split('\n');

    // Get BNB price in USD
    const bnbPrice = await getTokenPrice('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');

    // Process each wallet address one by one
    for (const address of splitAddresses) {
        try {
            // Get all transactions for the wallet address.
            const transactions = await getAllTransactions(address);

            if (transactions.length < process.env.TRANSACTIONS_COUNT) {

                // Get all swap related transactions (buy, sell).
                const swaps = await getWalletTokenSwaps(address);

                // Get the full transaction history of a specified wallet address.
                const transactions = await getWalletHistory(address);

                // Get token balances for a specific wallet address.
                const balances = await getWalletTokenBalances(address);

                // Get the active chains for a wallet address.
                const chains = await getActiveWalletChains(address);

                // Get lost swaps and transfers.
                const {lostSwaps, transfers} = await checkTransactionHistory(address, swaps, transactions);
                const transactionFrequency = transactionsFrequency(address, transactions);

                const tokenData = {};

                // Compare the swaps with the lost swaps.
                const allSwaps = [...swaps, ...lostSwaps];

                for (const swap of allSwaps) {
                    const {bought, sold, transactionType} = swap;
                    if (!bought || !sold) continue;

                    const boughtSymbol = bought.symbol;
                    const soldSymbol = sold.symbol;
                    const boughtAddress = bought.address;
                    const soldAddress = sold.address;

                    // Handle BUY transactions.
                    if (transactionType === 'buy') {
                        const token = boughtAddress;
                        if (!tokenData[token]) {
                            tokenData[token] = {
                                boughtAmount: 0,
                                soldAmount: 0,
                                spent: 0,
                                received: 0,
                                contractAddress: boughtAddress,
                                symbol: boughtSymbol,
                                balance: 0,
                                trades: []
                            };
                        }
                        tokenData[token].boughtAmount += parseFloat(bought.amount);
                        tokenData[token].spent += Math.abs(parseFloat(sold.amount));
                        tokenData[token].trades.push(swap);
                    }

                    // Handle SELL transactions.
                    if (transactionType === 'sell') {
                        const token = soldAddress;
                        if (!tokenData[token]) {
                            tokenData[token] = {
                                boughtAmount: 0,
                                soldAmount: 0,
                                spent: 0,
                                received: 0,
                                contractAddress: soldAddress,
                                symbol: soldSymbol,
                                balance: 0,
                                trades: [],
                            };
                        }
                        tokenData[token].soldAmount += Math.abs(parseFloat(sold.amount));
                        tokenData[token].received += parseFloat(bought.amount);
                        tokenData[token].trades.push(swap);
                    }
                }


                // Convert USD balances to WBNB equivalents.
                for (const token of balances) {
                    const contractAddress = token.token_address;
                    if (tokenData[contractAddress]) {
                        const usdValue = token.usd_value || 0;
                        tokenData[contractAddress].balance = usdValue / bnbPrice.usdPrice.toFixed(2);
                    }
                }

                // Add calculated data to JSON.
                const addressData = {
                    chain_id: 'bsc',
                    active_chains: chains,
                    win_rate: '',
                    average_pnl: '',
                    address_info: {
                        total_transactions: transactions.length,
                        total_tokens_traded: Object.entries(tokenData).length,
                        transaction_frequency: transactionFrequency,
                    },
                    traded_tokens: {},
                };

                let sumRealizedPnls = 0;
                let tokenCount = 0;

                let winCount = 0;
                let totalEvaluatedTokens = 0;

                for (const [contract, stats] of Object.entries(tokenData)) {
                    let inflowCount = 0;
                    let outflowCount = 0;
                    let winRate = null;

                    const realizedPnl = stats.balance + (stats.received - stats.spent);

                    const tokenTransfers = transfers.filter(i => i.contract === contract);

                    const buyCount = stats.trades.filter(trade => trade.transactionType === 'buy').length;
                    const sellCount = stats.trades.filter(trade => trade.transactionType === 'sell').length;

                    sumRealizedPnls += realizedPnl;
                    tokenCount++;

                    tokenTransfers.forEach(transfer => {
                        if (transfer.from.toLowerCase() === address.toLowerCase()) {
                            outflowCount++;
                        }
                        if (transfer.to.toLowerCase() === address.toLowerCase()) {
                            inflowCount++;
                        }
                    });

                    if (Number(realizedPnl.toFixed(2)) > 0.3) {
                        winRate = true;
                    } else if (Number(realizedPnl.toFixed(2)) < -0.3) {
                        winRate = false;
                    }

                    if (winRate !== null) {
                        totalEvaluatedTokens++;
                        if (winRate === true) {
                            winCount++;
                        }
                    }

                    const avgHoldingHours = averageHoldingHours(stats.trades);

                    addressData.traded_tokens[contract] = {
                        symbol: stats.symbol,
                        spent: Number(stats.spent.toFixed(2)),
                        pnl: {
                            total: Number(realizedPnl.toFixed(2)),
                            realized: Number(stats.received.toFixed(2)),
                            unrealized: Number(stats.balance.toFixed(2)),
                        },
                        avg_holding_hours: avgHoldingHours,
                        transfers: {
                            inflow_count: inflowCount,
                            outflow_count: outflowCount,
                        },
                        trades: {
                            buy_count: buyCount,
                            sell_count: sellCount,
                        },
                    };
                }

                const overallAverage = tokenCount ? sumRealizedPnls / tokenCount : 0;

                addressData.average_pnl = Number(overallAverage.toFixed(2));
                addressData.win_rate = `${totalEvaluatedTokens > 0 ? Number(((winCount / totalEvaluatedTokens) * 100).toFixed(2)) : 0}%`;

                const tradedTokens = addressData.traded_tokens;

                for (const token of contracts) {
                    const lowerToken = token.toLowerCase();
                    if (tradedTokens[lowerToken]) {
                        delete tradedTokens[lowerToken];
                    }
                }

                const filePath = `${addressData.win_rate} ${addressData.average_pnl}bnb - ${address}.json`;
                fs.writeFileSync(filePath, JSON.stringify({[address]: addressData}, null, 2));

                const options = {
                    caption: `\`${address}\``,
                    parse_mode: 'Markdown',
                };

                await bot.sendDocument(chatId, filePath, options);
                fs.unlinkSync(filePath);

                const menuOptions = {
                    reply_markup: JSON.stringify({
                        inline_keyboard: [
                            [{text: 'Wallet address', callback_data: 'option1'}],
                        ]
                    })
                };
                await bot.sendMessage(chatId, 'Choose an option:', menuOptions);
            } else {
                bot.sendMessage(chatId, `Transactions count address more then ${process.env.TRANSACTIONS_COUNT} \n\`${address}\``, {
                    parse_mode: 'MarkdownV2',
                });
                const menuOptions = {
                    reply_markup: JSON.stringify({
                        inline_keyboard: [
                            [{text: 'Wallet address', callback_data: 'option1'}],
                        ]
                    })
                };
                await bot.sendMessage(chatId, 'Choose an option:', menuOptions);
            }
        } catch (error) {
            console.error(`Error parsing wallet ${address}:`, error.message);
            await bot.sendMessage(chatId, `Error parsing wallet \`${address}\`: ${error.message}`, {parse_mode: 'Markdown'});
        }

    }
};

module.exports = {walletParser};
