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
    let highest = pairs[0];
    for (const p of pairs) {
        if (p.liquidity?.usd > highest.liquidity?.usd) highest = p;
    }
    return highest.pairCreatedAt;
};

const walletParserCore = async (addresses, bot, chatId, chainsToProcess) => {
    const splitAddresses = addresses.split('\n');

    for (const address of splitAddresses) {
        try {
            const activeChains = await getActiveWalletChains(address);
            const chains = chainsToProcess.length ? chainsToProcess : activeChains;
            const chainResults = {};

            for (const chainKey of chains) {
                const cfg = config[chainKey];
                if (!cfg) continue;

                const transactions = await getAllTransactions(address, cfg.chain_id);
                if (transactions.length >= parseInt(process.env.TRANSACTIONS_COUNT, 10)) {
                    await bot.sendMessage(
                        chatId,
                        `Transactions count address more then ${process.env.TRANSACTIONS_COUNT} \n\`${address}\``,
                        {parse_mode: 'MarkdownV2'}
                    );
                    continue;
                }

                const {usdPrice} = await getTokenPrice(cfg.contract, cfg.chain);
                const transactionsHistory = await getWalletHistory(address, cfg.chain);
                const balances = await getWalletTokenBalances(address, cfg.chain);

                const {swaps: initialSwaps, transfers: initialTransfers} =
                    await createHistorySwaps(cfg, address, transactionsHistory, usdPrice);

                // Використовуємо локальні копії для подальших розрахунків
                let swaps = initialSwaps;
                let transfers = initialTransfers;

                // Налаштовуємо структуру tokenData
                const tokenData = {};
                for (const swap of swaps) {
                    const {bought, sold, transactionType} = swap;
                    if (!bought || !sold) continue;
                    const boughtAddr = bought.address?.toLowerCase();
                    const soldAddr = sold.address?.toLowerCase();

                    if (transactionType === 'buy' && boughtAddr) {
                        if (!tokenData[boughtAddr]) {
                            tokenData[boughtAddr] = {
                                spent: 0,
                                spent_token: 0,
                                received: 0,
                                receive_token: 0,
                                contractAddress: bought.address,
                                pairAddress: bought.pairAddress,
                                symbol: bought.symbol,
                                balance: 0,
                                trades: [],
                            };
                        }
                        tokenData[boughtAddr].spent += Math.abs(parseFloat(sold.amount));
                        tokenData[boughtAddr].spent_token += Math.abs(parseFloat(bought.amount));
                        tokenData[boughtAddr].trades.push(swap);
                    }

                    if (transactionType === 'sell' && soldAddr) {
                        if (!tokenData[soldAddr]) {
                            tokenData[soldAddr] = {
                                spent: 0,
                                spent_token: 0,
                                received: 0,
                                receive_token: 0,
                                contractAddress: sold.address,
                                pairAddress: sold.pairAddress,
                                symbol: sold.symbol,
                                balance: 0,
                                trades: [],
                            };
                        }
                        tokenData[soldAddr].received += parseFloat(bought.amount);
                        tokenData[soldAddr].receive_token += Math.abs(parseFloat(sold.amount));
                        tokenData[soldAddr].trades.push(swap);
                    }
                }

                // Конвертація балансів
                const formatUnitsManual = (value, decimals = 18) => {
                    let s = value.toString();
                    if (s.length <= decimals) s = s.padStart(decimals + 1, '0');
                    const intPart = s.slice(0, s.length - decimals);
                    let frac = s.slice(s.length - decimals).replace(/0+$/, '');
                    return `${intPart}${frac ? '.' + frac : ''}`;
                };

                for (const bal of balances) {
                    const addr = bal.token_address?.toLowerCase();
                    if (!tokenData[addr]) continue;
                    const amt = parseFloat(formatUnitsManual(bal.balance, bal.decimals));
                    let usdVal = bal.usd_value;
                    if (!usdVal || usdVal === 0) {
                        const ds = await getDexscreenerTokenPrice(addr, cfg.dexscreener_chain_id);
                        usdVal = amt * Number(ds[0]?.priceUsd || 0);
                    }
                    tokenData[addr].balance = usdVal / usdPrice;
                }

                // Фільтрація токенів без трейдів
                for (const [c, stats] of Object.entries(tokenData)) {
                    const inflows = transfers.filter(t =>
                        ['receive', 'token receive'].includes(t.category)
                    ).length;
                    const buys = stats.trades.filter(t => t.transactionType === 'buy').length;
                    const sells = stats.trades.filter(t => t.transactionType === 'sell').length;
                    if (inflows > 0 && buys === 0 && sells === 0) delete tokenData[c];
                }

                // Виключені контракти
                for (const ex of [...cfg.excluded_contracts, address?.toLowerCase()]) {
                    if (tokenData[ex]) delete tokenData[ex];
                }

                mergeVirtualTokens(tokenData);

                // Meta для адреси
                const txFreq = transactionsFrequency(address, transactionsHistory);
                const assocAddrs = associatedAddresses(address, transactionsHistory);
                const firstTx = transactionsHistory.find(tx => tx.summary?.includes(cfg.symbol));

                const addressData = {
                    chain_id: cfg.chain,
                    active_chains: activeChains,
                    roi_pct: '',
                    average_pnl: '',
                    median_holding_hours: '',
                    first_transaction: {
                        timestamp: firstTx?.block_timestamp,
                        hash: firstTx?.hash,
                        from: firstTx?.from_address,
                        type: firstTx?.category,
                        summary: firstTx?.summary,
                    },
                    associated_addresses: assocAddrs,
                    address_info: {
                        total_transactions: transactions.length,
                        total_tokens_traded: Object.keys(tokenData).length,
                        transaction_frequency: txFreq,
                    },
                    traded_tokens: {},
                };

                // PnL / ROI
                let sumPnls = 0,
                    countTokens = 0,
                    sumSpent = 0,
                    sumRealized = 0;

                for (const [contract, stats] of Object.entries(tokenData)) {
                    let inflowC = 0,
                        outflowC = 0,
                        inflowAmt = 0,
                        outflowAmt = 0,
                        diffMin = null;

                    const pairStat = await getDexscreenerTokenPrice(contract, cfg.dexscreener_chain_id);
                    const pairCreatedAt = getPairCreatedAtWithHighestLiquidity(pairStat);

                    if (stats.trades.length > 0) {
                        const firstTrade = stats.trades
                            .slice()
                            .sort((a, b) => new Date(a.blockTimestamp) - new Date(b.blockTimestamp))[0];
                        const t0 = new Date(pairCreatedAt);
                        const t1 = new Date(firstTrade.blockTimestamp);
                        diffMin = pairCreatedAt ? Math.round((t1 - t0) / 60000) : null;
                    }

                    const allContracts = [contract];
                    if (stats.same_contracts) {
                        allContracts.push(...Object.keys(stats.same_contracts));
                    }

                    const tokenTransfers = transfers.filter(t =>
                        allContracts.includes(t.contract?.toLowerCase())
                    );
                    for (const t of tokenTransfers) {
                        const v = Math.abs(parseFloat(t.value));
                        if (['send', 'token send'].includes(t.category)) {
                            outflowC++;
                            outflowAmt += v;
                        }
                        if (['receive', 'token receive'].includes(t.category)) {
                            inflowC++;
                            inflowAmt += v;
                        }
                    }

                    const realizedPnl = stats.balance + (stats.received - stats.spent);
                    sumPnls += realizedPnl;
                    countTokens++;

                    const roiPctToken =
                        stats.spent > 0 ? Number(((realizedPnl / stats.spent) * 100).toFixed(2)) : null;
                    const isProf = stats.spent > 0 ? realizedPnl > 0 : null;

                    if (stats.spent > 0) {
                        sumSpent += stats.spent;
                        sumRealized += realizedPnl;
                    }

                    const outflowMatch =
                        stats.spent_token > 0 &&
                        Math.abs(outflowAmt - stats.spent_token) <= stats.spent_token * 0.1;
                    const inflowMatch =
                        stats.receive_token > 0 &&
                        Math.abs(inflowAmt - stats.receive_token) <= stats.receive_token * 0.1;

                    const counterparties = [
                        ...new Set(
                            tokenTransfers.map((t) =>
                                ['send', 'token send'].includes(t.category) ? t.to : t.from
                            )
                        ),
                    ];

                    // Нова логіка: якщо єдиний контрагент — підтягуємо його свапи/трансфери по цьому токену
                    if ((outflowMatch || inflowMatch) && counterparties.length === 1) {
                        const counterparty = counterparties[0]?.toLowerCase();
                        const cpHistory = await getWalletHistory(counterparty, cfg.chain);
                        const {swaps: cpSwapsAll, transfers: cpTransfersAll} =
                            await createHistorySwaps(cfg, counterparty, cpHistory, usdPrice);

                        const cpSwaps = cpSwapsAll.filter(
                            (s) =>
                                s.bought.address?.toLowerCase() === contract ||
                                s.sold.address?.toLowerCase() === contract
                        );
                        const cpTransfers = cpTransfersAll.filter(
                            (t) => t.contract?.toLowerCase() === contract
                        );

                        // додаємо до trades і зберігаємо дочірні записи
                        stats.trades.push(...cpSwaps);
                        stats.child_swaps = cpSwaps;
                        stats.child_transfers = cpTransfers;
                    }

                    const avgHrs = averageHoldingHours(stats.trades);
                    const earlyEntry = avgHrs > 0 ? diffMin > 5 : null;

                    addressData.traded_tokens[contract] = {
                        symbol: stats.symbol,
                        spent: Number(stats.spent.toFixed(2)),
                        roi_pct_token: roiPctToken,
                        is_profitable: isProf,
                        is_roi_calculated: stats.spent > 0,
                        pnl: {
                            total: Number(realizedPnl.toFixed(2)),
                            realized: Number(stats.received.toFixed(2)),
                            unrealized: Number(stats.balance.toFixed(2)),
                        },
                        avg_holding_hours: avgHrs,
                        transfers: {
                            inflow_count: inflowC,
                            outflow_count: outflowC,
                        },
                        minutes_after_launch_to_buy: diffMin,
                        early_entry: earlyEntry,
                        trades: {
                            buy_count: stats.trades.filter((t) => t.transactionType === 'buy').length,
                            sell_count: stats.trades.filter((t) => t.transactionType === 'sell').length,
                        },
                        ...(stats.same_contracts && {same_contracts: stats.same_contracts}),
                        ...(stats.trades.filter((t) => t.transactionType === 'buy').length > 0 &&
                            stats.received === 0 &&
                            stats.balance === 0 &&
                            outflowC === 0 && {note: 'excluded from ROI/accuracy due to zero cost basis'}),
                    };
                }

                const overallAvg = countTokens ? sumPnls / countTokens : 0;
                addressData.average_pnl = Number(overallAvg.toFixed(2));
                addressData.roi_pct =
                    sumSpent > 0 ? `${Number(((sumRealized / sumSpent) * 100).toFixed(0))}%` : null;

                const valid = Object.values(addressData.traded_tokens).filter((t) => t.spent > 0);
                const totalSpent = valid.reduce((s, t) => s + t.spent, 0);
                const accuracyPct =
                    valid.length > 0 ? (valid.filter((t) => t.pnl.total > 0).length / valid.length) * 100 : null;
                const avgTokenRoiPct =
                    valid.length > 0
                        ? valid.reduce((s, t) => s + (t.pnl.total / t.spent) * 100, 0) / valid.length
                        : null;

                let consScore = null;
                if (valid.length >= 2) {
                    const vals = valid.map((t) => (t.pnl.total / t.spent) * 100);
                    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                    const variance =
                        vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1);
                    const sd = Math.sqrt(variance);
                    const cv = sd / mean;
                    consScore = Math.max(0, Math.min(10, 10 - cv * 2));
                }

                const weightedRoi =
                    totalSpent > 0
                        ? valid.reduce((s, t) => s + ((t.pnl.total / t.spent) * 100) * t.spent, 0) /
                        totalSpent
                        : null;

                addressData.performance_score = {
                    token_accuracy_pct: accuracyPct != null ? Number(accuracyPct.toFixed(2)) : null,
                    avg_token_roi_pct: avgTokenRoiPct != null ? Number(avgTokenRoiPct.toFixed(2)) : null,
                    roi_consistency_score: consScore != null ? Number(consScore.toFixed(2)) : null,
                    weighted_roi_score: weightedRoi != null ? Number(weightedRoi.toFixed(2)) : null,
                };

                chainResults[chainKey] = addressData;

                const filePath = `${addressData.average_pnl}${cfg.symbol?.toLowerCase()} - ${address}.json`;
                fs.writeFileSync(filePath, JSON.stringify({[address]: addressData}, null, 2));
                await bot.sendDocument(chatId, filePath, {caption: `\`${address}\``, parse_mode: 'Markdown'});
                fs.unlinkSync(filePath);
            }

            if (chains.length > 1) {
                const chain_stats = {};
                const summary_tags = [];
                let bestChain = null;
                let bestScore = -Infinity;

                for (const key of Object.keys(chainResults)) {
                    const data = chainResults[key];
                    const score = data.performance_score?.weighted_roi_score;
                    if (score != null) {
                        const tag = score > 0 ? '+' : score < 0 ? '-' : '0';
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
                                token_accuracy_pct: data.performance_score.token_accuracy_pct,
                            },
                            comment: '',
                        };
                    } else {
                        chain_stats[key] = {status: 'timeout'};
                    }
                }

                const aggregated = {
                    address,
                    cross_chain_summary: {
                        chain_stats,
                        highlights: {most_profitable_chain: bestChain, summary_tags},
                        notes: '',
                        last_updated: new Date().toISOString(),
                    },
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
            await bot.sendMessage(
                chatId,
                `Error parsing wallet \`${address}\`: ${error.message}`,
                {parse_mode: 'Markdown'}
            );
        }
    }
};

module.exports = {walletParserCore};
