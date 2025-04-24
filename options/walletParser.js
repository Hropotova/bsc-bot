require('dotenv').config();
const fs = require('fs');

const {
    getWalletTokenSwaps,
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getWalletHistory,
    getPairStats
} = require('../api/moralis');
const {getAllTransactions} = require('../api/scan');

const {checkTransactionHistory} = require('../services/checkTransactionHistory');
const {transactionsFrequency} = require('../services/transactionsFrequency');
const {associatedAddresses} = require('../services/associatedAddresses');
const {averageHoldingHours} = require('../services/averageHoldingHours');

const {contracts} = require('../constants/contracts');

const walletParser = async (addresses, bot, chatId) => {
    const splitAddresses = addresses.split('\n');

    // Get BNB price in USD
    const bnbPrice = await getTokenPrice(process.env.CHAIN_CONTRACT);

    // Process each wallet address one by one
    for (const address of splitAddresses) {
        try {
            // Get all transactions for the wallet address.
            const transactions = await getAllTransactions(address);

            if (transactions.length < process.env.TRANSACTIONS_COUNT) {

                // Get all swap related transactions (buy, sell).
                const swaps = await getWalletTokenSwaps(address);

                // Get the full transaction history of a specified wallet address.
                const transactionsHistory = await getWalletHistory(address);

                // Get token balances for a specific wallet address.
                const balances = await getWalletTokenBalances(address);

                // Get the active chains for a wallet address.
                const chains = await getActiveWalletChains(address);

                // Get lost swaps and transfers.
                const {
                    lostSwaps,
                    transfers,
                    mismatchedContracts
                } = await checkTransactionHistory(address, swaps, transactionsHistory);

                // Compare the swaps with the lost swaps.
                const allSwaps = [...swaps, ...lostSwaps];

                const tokenData = {};

                const seen = new Set();
                const uniqueSwaps = [];

                for (const swap of allSwaps) {
                    if (seen.has(swap.transactionHash)) continue;
                    seen.add(swap.transactionHash);
                    uniqueSwaps.push(swap);
                }

                for (const swap of uniqueSwaps) {
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
                                pairAddress: swap.pairAddress,
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
                                pairAddress: swap.pairAddress,
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

                // Filter traded tokens.
                for (const token of [...contracts, ...mismatchedContracts]) {
                    const lowerToken = token.toLowerCase();
                    if (tokenData[lowerToken]) {
                        delete tokenData[lowerToken];
                    }
                }

                // Get transaction frequency for address.
                const transaction_frequency = transactionsFrequency(address, transactionsHistory);

                // Get associated addresses.
                const associated_addresses = associatedAddresses(address, transactionsHistory);

                // Get first transaction that include native token.
                const firstTransaction = transactionsHistory.find(tx => tx.summary && tx.summary.includes(process.env.CHAIN_SYMBOL),);

                // Add calculated data to JSON.
                const addressData = {
                    chain_id: 'bsc',
                    active_chains: chains,
                    roi_pct: '',
                    average_pnl: '',
                    first_transaction: {
                        timestamp: firstTransaction.block_timestamp,
                        hash: firstTransaction.hash,
                        from: firstTransaction.from_address,
                        type: firstTransaction.category,
                        summary: firstTransaction.summary,
                    },
                    associated_addresses,
                    address_info: {
                        total_transactions: transactions.length,
                        total_tokens_traded: Object.entries(tokenData).length,
                        transaction_frequency,
                    },
                    traded_tokens: {},
                };

                let sumRealizedPnls = 0;
                let tokenCount = 0;

                let sumSpentForROI = 0;
                let sumPnLForROI = 0;

                for (const [contract, stats] of Object.entries(tokenData)) {
                    let inflowCount = 0;
                    let outflowCount = 0;
                    let diffMinutes = null
                    const pairStat = await getPairStats(stats.pairAddress);

                    if (Array.isArray(stats.trades) && stats.trades.length > 0) {
                        const sortedTrades = stats.trades.slice().sort(
                            (a, b) => new Date(a.blockTimestamp) - new Date(b.blockTimestamp)
                        );
                        const firstTrade = sortedTrades[0];
                        const createdTime = new Date(pairStat.pairCreated);
                        const firstBuyTime = new Date(firstTrade.blockTimestamp);
                        diffMinutes = Math.round((firstBuyTime - createdTime) / (1000 * 60));
                    }

                    const realizedPnl = stats.balance + (stats.received - stats.spent);

                    const tokenTransfers = transfers.filter(i => i.contract === contract);

                    const buyCount = stats.trades.filter(trade => trade.transactionType === 'buy').length;
                    const sellCount = stats.trades.filter(trade => trade.transactionType === 'sell').length;

                    sumRealizedPnls += realizedPnl;
                    tokenCount++;

                    const roiPctToken = stats.spent > 0
                        ? Number(((realizedPnl / stats.spent) * 100).toFixed(2))
                        : null;

                    const isProfitable = stats.spent > 0 ? realizedPnl > 0 : null;
                    const isRoiCalculated = stats.spent > 0;

                    if (stats.spent > 0) {
                        sumSpentForROI += stats.spent;
                        sumPnLForROI += realizedPnl;
                    }

                    tokenTransfers.forEach(transfer => {
                        if (transfer.from.toLowerCase() === address.toLowerCase()) {
                            outflowCount++;
                        }
                        if (transfer.to.toLowerCase() === address.toLowerCase()) {
                            inflowCount++;
                        }
                    });

                    const avgHoldingHours = averageHoldingHours(stats.trades);

                    addressData.traded_tokens[contract] = {
                        symbol: stats.symbol,
                        spent: Number(stats.spent.toFixed(2)),
                        roi_pct_token: roiPctToken,
                        is_profitable: isProfitable,
                        is_roi_calculated: isRoiCalculated,
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
                        launch_time_first_buy: diffMinutes,
                        trades: {
                            buy_count: buyCount,
                            sell_count: sellCount,
                        },
                        ...(stats.spent === 0 && {
                            note: 'excluded from ROI/accuracy due to zero cost basis'
                        })
                    };
                }

                const overallAverage = tokenCount ? sumRealizedPnls / tokenCount : 0;

                addressData.average_pnl = Number(overallAverage.toFixed(2));
                addressData.roi_pct = sumSpentForROI > 0 ? `${Number(((sumPnLForROI / sumSpentForROI) * 100).toFixed(0))}%` : null;

                const tokens = Object.values(addressData.traded_tokens);
                const validTokens = tokens.filter(t => t.spent > 0);
                const totalSpent = validTokens.reduce((sum, t) => sum + t.spent, 0);

                const token_accuracy_pct = validTokens.length
                    ? (validTokens.filter(t => t.pnl.total > 0).length / validTokens.length) * 100
                    : null;

                const avg_token_roi_pct = validTokens.length
                    ? validTokens.reduce((sum, t) => sum + (t.pnl.total / t.spent) * 100, 0) / validTokens.length
                    : null;

                let roi_consistency_score = null;
                if (validTokens.length >= 2) {
                    const roiValues = validTokens.map(t => (t.pnl.total / t.spent) * 100);
                    const mean = roiValues.reduce((a, b) => a + b, 0) / roiValues.length;
                    const variance = roiValues.reduce((a, b) => a + (b - mean) ** 2, 0) / (roiValues.length - 1);
                    const sd = Math.sqrt(variance);
                    const cv = sd / mean;
                    roi_consistency_score = Math.max(0, Math.min(10, 10 - cv * 2));
                }

                const weighted_roi_score = totalSpent
                    ? validTokens.reduce((sum, t) => sum + ((t.pnl.total / t.spent) * 100) * t.spent, 0) / totalSpent
                    : null;

                addressData.performance_score = {
                    token_accuracy_pct: token_accuracy_pct != null ? Number(token_accuracy_pct.toFixed(2)) : null,
                    avg_token_roi_pct: avg_token_roi_pct != null ? Number(avg_token_roi_pct.toFixed(2)) : null,
                    roi_consistency_score: roi_consistency_score != null ? Number(roi_consistency_score.toFixed(2)) : null,
                    weighted_roi_score: weighted_roi_score != null ? Number(weighted_roi_score.toFixed(2)) : null
                };

                // Agent summary block.
                addressData.agent_summary = {
                    raw: '',
                    tags: [],
                };


                // Manual feedback block.
                addressData.manual_feedback = {
                    decision: '',
                    note: '',
                    timestamp: '',
                }

                const filePath = `${addressData.average_pnl}${process.env.CHAIN_SYMBOL.toLowerCase()} - ${address}.json`;

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
            console.error(`Error parsing wallet ${address}:`, error);
            await bot.sendMessage(chatId, `Error parsing wallet \`${address}\`: ${error}`, {parse_mode: 'Markdown'});
        }

    }
};

module.exports = {walletParser};
