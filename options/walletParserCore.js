require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getWalletHistory,
} = require('../api/moralis');
const {getAllTransactions} = require('../api/scan');
const {getDexscreenerTokenPrice} = require('../api/dexscreener');

const {
    createHistorySwaps,
    transactionsFrequency,
    associatedAddresses,
    averageHoldingHours,
    mergeVirtualTokens,
} = require('../controlers');

const config = require('../config.js');

const getPairCreatedAtWithHighestLiquidity = (pairs) => {
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    let highestLiquidityPair = pairs[0];

    for (const pair of pairs) {
        if (pair.liquidity?.usd > highestLiquidityPair.liquidity?.usd) {
            highestLiquidityPair = pair;
        }
    }

    return highestLiquidityPair.pairCreatedAt;
}

const walletParserCore = async (addresses, bot, chatId, chainsToProcess) => {
    const splitAddresses = addresses.split('\n');

    // Process each wallet address one by one
    for (const address of splitAddresses) {
        try {
            // Get the active chains for a wallet address.
            const activeChains = await getActiveWalletChains(address);

            const chains = chainsToProcess.length ? chainsToProcess : activeChains;

            const chainResults = {};

            for (const chainKey of chains) {
                const cfg = config[chainKey];
                if (!cfg) continue;

                // Get all transactions for the wallet address.
                const transactions = await getAllTransactions(address, cfg.chain_id);

                if (transactions.length < process.env.TRANSACTIONS_COUNT) {

                    // Get native token price in USD
                    const {usdPrice} = await getTokenPrice(cfg.contract, cfg.chain);

                    // Get the full transaction history of a specified wallet address.
                    const transactionsHistory = await getWalletHistory(address, cfg.chain);

                    // Get token balances for a specific wallet address.
                    const balances = await getWalletTokenBalances(address, cfg.chain);

                    // Get lost swaps and transfers.
                    const {swaps, transfers} = await createHistorySwaps(cfg, address, transactionsHistory, usdPrice);

                    const targetHashes = [
                        '0xeb553b8139066872b7a8b193ae8ac8208865ff75d91795df1547a78d5e3c7dce',
                        '0xdeefa72fc5a75e1859de8d385bd284cbbf4bfd275f27cd008a4c87c44fe7fc7f',
                        '0x0d27241e61440ad6cfa2f2566f3b27b98ac1bacaf60ef7c6e0aaee2751acbf3b',
                        '0x4930677edbebf2ca183a17e4f30f8e05c59116b2c3fb38cc4512ee5a63efdf7a',
                        '0x4e6a67bb8e7673be17e59f2d8ef3fde0ea906d5e9955e0ed2134dfe159b29a95',
                        '0xce363b0d7c04dcbf18dcb378590362f412d37ae7722518d40337b546a7015f3b',
                        '0xd145eeb9d05c7d342d99043a9b01879fcd3bab2724e700c42cae902bd54df427',
                        '0x2ff36e5725af767e84260acc4df0464775d1df31a0fa3744ec06cbe4e98b2e33',
                    ];

                    const lowerCaseHashes = targetHashes.map(h => h.toLowerCase());

                    const matchingTransactions = transactionsHistory.filter(tx =>
                        lowerCaseHashes.includes(tx.hash.toLowerCase())
                    );

                    matchingTransactions.forEach(tx => {
                        console.log(tx);
                    });

                    const tokenData = {};

                    for (const swap of swaps) {
                        const {bought, sold, transactionType} = swap;
                        if (!bought || !sold) continue;

                        const boughtSymbol = bought.symbol;
                        const soldSymbol = sold.symbol;
                        const boughtAddress = bought.address;
                        const soldAddress = sold.address;

                        // Handle BUY transactions.
                        if (transactionType === 'buy' && boughtAddress) {
                            const token = boughtAddress.toLowerCase();

                            if (!tokenData[token]) {
                                tokenData[token] = {
                                    spent: 0,
                                    received: 0,
                                    contractAddress: boughtAddress,
                                    pairAddress: bought.pairAddress,
                                    symbol: boughtSymbol,
                                    balance: 0,
                                    trades: []
                                };
                            }
                            tokenData[token].spent += Math.abs(parseFloat(sold.amount));
                            tokenData[token].trades.push(swap);
                        }

                        // Handle SELL transactions.
                        if (transactionType === 'sell' && soldAddress) {
                            const token = soldAddress.toLowerCase();

                            if (!tokenData[token]) {
                                tokenData[token] = {
                                    spent: 0,
                                    received: 0,
                                    contractAddress: soldAddress,
                                    pairAddress: sold.pairAddress,
                                    symbol: soldSymbol,
                                    balance: 0,
                                    trades: [],
                                };
                            }
                            tokenData[token].received += parseFloat(bought.amount);
                            tokenData[token].trades.push(swap);
                        }
                    }

                    // Convert USD balances to Native Token equivalents.
                    function formatUnitsManual(value, decimals = 18) {
                        let s = value.toString();

                        if (s.length <= decimals) {
                            s = s.padStart(decimals + 1, '0');
                        }

                        const intPart = s.slice(0, s.length - decimals);
                        let fracPart = s.slice(s.length - decimals);

                        fracPart = fracPart.replace(/0+$/, '');

                        return `${intPart}${fracPart ? '.' + fracPart : ''}`;
                    }

                    for (const token of balances) {
                        const addr = token.token_address;
                        if (!tokenData[addr]) continue;

                        const amountStr = formatUnitsManual(token.balance, token.decimals);
                        const amount = parseFloat(amountStr);

                        let usdValue = token.usd_value;
                        if (!usdValue || usdValue === 0) {
                            const data = await getDexscreenerTokenPrice(addr, cfg.dexscreener_chain_id);
                            usdValue = amount * Number(data[0]?.priceUsd || 0);
                        }

                        tokenData[addr].balance = usdValue / usdPrice;
                    }

                    // Remove tokens with no inflow and no trades.
                    for (const [contract, stats] of Object.entries(tokenData)) {
                        const inflowCount = transfers.filter(t => t.category === 'receive' || t.category === 'token receive').length;

                        const buyCount = stats.trades.filter(trade => trade.transactionType === 'buy').length;
                        const sellCount = stats.trades.filter(trade => trade.transactionType === 'sell').length;

                        if (inflowCount > 0 && buyCount === 0 && sellCount === 0) {
                            delete tokenData[contract];
                        }
                    }

                    // Filter traded tokens.
                    for (const token of [...cfg.excluded_contracts, address]) {
                        const lowerToken = token.toLowerCase();
                        if (tokenData[lowerToken]) {
                            delete tokenData[lowerToken];
                        }
                    }

                    // Merge virtual tokens.
                    mergeVirtualTokens(tokenData);

                    // Get transaction frequency for address.
                    const transaction_frequency = transactionsFrequency(address, transactionsHistory);

                    // Get associated addresses.
                    const associated_addresses = associatedAddresses(address, transactionsHistory);

                    // Get first transaction that include native token.
                    const firstTransaction = transactionsHistory.find(tx => tx.summary && tx.summary.includes(cfg.symbol));

                    // Add calculated data to JSON.
                    const addressData = {
                        chain_id: cfg.chain,
                        active_chains: activeChains,
                        roi_pct: '',
                        average_pnl: '',
                        median_holding_hours: '',
                        first_transaction: {
                            timestamp: firstTransaction?.block_timestamp,
                            hash: firstTransaction?.hash,
                            from: firstTransaction?.from_address,
                            type: firstTransaction?.category,
                            summary: firstTransaction?.summary,
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

                        const pairStat = await await getDexscreenerTokenPrice(contract, cfg.dexscreener_chain_id);

                        const pairCreatedAt = getPairCreatedAtWithHighestLiquidity(pairStat);

                        if (Array.isArray(stats.trades) && stats.trades.length > 0) {
                            const sortedTrades = stats.trades.slice().sort(
                                (a, b) => new Date(a.blockTimestamp) - new Date(b.blockTimestamp)
                            );
                            const firstTrade = sortedTrades[0];

                            const createdTime = new Date(pairCreatedAt);
                            const firstBuyTime = new Date(firstTrade.blockTimestamp);

                            diffMinutes = pairCreatedAt && Math.round((firstBuyTime - createdTime) / (1000 * 60));
                        }

                        const realizedPnl = stats.balance + (stats.received - stats.spent);

                        const allTokenContracts = [contract.toLowerCase()];
                        if (stats.same_contracts) {
                            allTokenContracts.push(...Object.keys(stats.same_contracts).map(c => c));
                        }

                        const tokenTransfers = transfers.filter(i => allTokenContracts.includes(i.contract));

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

                            if (transfer.category === 'send' || transfer.category === 'token send') {
                                outflowCount++;
                            }
                            if (transfer.category === 'receive' || transfer.category === 'token receive') {
                                inflowCount++;
                            }
                        });

                        const avgHoldingHours = averageHoldingHours(stats.trades);
                        const earlyEntry = avgHoldingHours > 0 ? diffMinutes > 5 : null;

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
                            minutes_after_launch_to_buy: diffMinutes,
                            early_entry: earlyEntry,
                            trades: {
                                buy_count: buyCount,
                                sell_count: sellCount,
                            },
                            ...((buyCount > 0 && stats.received === 0 && stats.balance === 0 && outflowCount === 0) && {
                                note: 'excluded from ROI/accuracy due to zero cost basis'
                            }),
                            ...(stats.same_contracts) && {
                                same_contracts: stats.same_contracts,

                            }
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

                    // Add performance score to address data.
                    addressData.performance_score = {
                        token_accuracy_pct: token_accuracy_pct != null ? Number(token_accuracy_pct.toFixed(2)) : null,
                        avg_token_roi_pct: avg_token_roi_pct != null ? Number(avg_token_roi_pct.toFixed(2)) : null,
                        roi_consistency_score: roi_consistency_score != null ? Number(roi_consistency_score.toFixed(2)) : null,
                        weighted_roi_score: weighted_roi_score != null ? Number(weighted_roi_score.toFixed(2)) : null
                    };

                    // Save result for this chain
                    chainResults[chainKey] = addressData;

                    const filePath = `${addressData.average_pnl}${cfg.symbol.toLowerCase()} - ${address}.json`;

                    fs.writeFileSync(filePath, JSON.stringify({[address]: addressData}, null, 2));

                    await bot.sendDocument(chatId, filePath, {caption: `\`${address}\``, parse_mode: 'Markdown'});

                    fs.unlinkSync(filePath);
                } else {
                    await bot.sendMessage(chatId,
                        `Transactions count address more then ${process.env.TRANSACTIONS_COUNT} \n\`${address}\``,
                        {parse_mode: 'MarkdownV2'}
                    );
                }
            }

            if (chains.length > 1) {
                const chain_stats = {};
                const summary_tags = [];
                let bestChain = null;
                let bestScore = -Infinity;

                for (const key of Object.keys(chainResults)) {
                    const data = chainResults[key];
                    if (data.performance_score && data.performance_score.weighted_roi_score != null) {
                        const score = data.performance_score.weighted_roi_score;
                        const tag = score > 0 ? '+' : (score < 0 ? '-' : '0');
                        summary_tags.push(`${key}${tag}`);
                        if (score > bestScore) {
                            bestScore = score;
                            bestChain = key;
                        }
                        chain_stats[key] = {
                            status: 'complete',
                            score,
                            tag,
                            performance: {
                                weighted_roi_score: data.performance_score.weighted_roi_score,
                                roi_consistency_score: data.performance_score.roi_consistency_score,
                                token_accuracy_pct: data.performance_score.token_accuracy_pct
                            },
                            comment: ''
                        };
                    } else {
                        chain_stats[key] = {status: 'timeout'};
                    }
                }

                const aggregated = {
                    address,
                    cross_chain_summary: {
                        chain_stats,
                        highlights: {
                            most_profitable_chain: bestChain,
                            summary_tags
                        },
                        notes: "",
                        last_updated: new Date().toISOString()
                    }
                };

                const aggDir = path.resolve(__dirname, '..', 'aggregates');

                if (!fs.existsSync(aggDir)) fs.mkdirSync(aggDir, {recursive: true});

                const aggPath = path.join(aggDir, `${address}_multichain.json`);

                fs.writeFileSync(aggPath, JSON.stringify(aggregated, null, 2));


                await bot.sendDocument(chatId, aggPath, {caption: `\`${address}\``, parse_mode: 'Markdown'});

                fs.unlinkSync(aggPath);
            }

        } catch (error) {
            console.error(`Error parsing wallet ${address}:`, error);
            await bot.sendMessage(chatId,
                `Error parsing wallet \`${address}\`: ${error.message}`,
                {parse_mode: 'Markdown'}
            );
        }
    }
};

module.exports = {walletParserCore};
