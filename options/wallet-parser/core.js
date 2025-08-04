require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getWalletHistory,
} = require('../../api/moralis');
const {getCode} = require('../../api/moralis-rpc');
const {getAllTransactions} = require('../../api/scan');
const {getDexscreenerTokenPrice} = require('../../api/dexscreener');

const {
    createHistorySwaps,
    transactionsFrequency,
    associatedAddresses,
    averageHoldingHours,
    mergeVirtualTokens,
} = require('../../controlers');

const config = require('../../config.js');

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

            const chains = chainsToProcess.length === 1 ? chainsToProcess : activeChains;

            const chainResults = {};
            for (const chainKey of chains) {
                const cfg = config[chainKey];
                if (!cfg) continue;

                const code = await getCode(address, cfg.rpc_url, cfg.chain);
                console.log('code', code)
                const isAddress = code === '0x' || code === '0x0';

                if (isAddress) {
                    // Get all transactions for the wallet address.
                    const transactions = await getAllTransactions(address, cfg.chain_id);

                    if (transactions.length < process.env.TRANSACTIONS_COUNT) {
                        // Get the full transaction history of a specified wallet address.
                        const transactionsHistory = await getWalletHistory(address, cfg.chain);

                        if (transactionsHistory === 'TRANSACTIONS_COUNT_LIMIT') {
                            await bot.sendMessage(chatId,
                                `Transactions count address more then ${process.env.TRANSACTIONS_COUNT} \n\`${address}\``,
                                {parse_mode: 'MarkdownV2'}
                            );
                            continue;
                        }

                        // Get native token price in USD
                        const {usdPrice} = await getTokenPrice(cfg.contract, cfg.chain);

                        // Get token balances for a specific wallet address.
                        const balances = await getWalletTokenBalances(address, cfg.chain);

                        // Get lost swaps and transfers.
                        const {
                            swaps,
                            transfers
                        } = await createHistorySwaps(cfg, address, transactionsHistory, usdPrice);

                        let allSwaps = [...swaps];
                        let allTransfers = [...transfers];
                        const initialStats = {};

                        for (const swap of swaps) {
                            const {bought, sold, transactionType} = swap;
                            if (transactionType === 'buy' && bought.address) {
                                const key = bought.address.toLowerCase();
                                initialStats[key] ??= {spent_token: 0, receive_token: 0};
                                initialStats[key].spent_token += Math.abs(parseFloat(bought.amount));
                            }
                            if (transactionType === 'sell' && sold.address) {
                                const key = sold.address.toLowerCase();
                                initialStats[key] ??= {spent_token: 0, receive_token: 0};
                                initialStats[key].receive_token += Math.abs(parseFloat(sold.amount));
                            }
                        }

                        for (const [contract] of Object.entries(initialStats)) {
                            const counterparties = [...new Set(
                                transfers
                                    .filter(t => t.contract?.toLowerCase() === contract)
                                    .map(t => (['send', 'token send'].includes(t.category) ? t.to : t.from).toLowerCase())
                            )];

                            if (counterparties.length === 1) {
                                const cp = counterparties[0];
                                const code = await getCode(cp, cfg.rpc_url, cfg.chain);
                                const isEOA = code === '0x' || code === '0x0';
                                if (!isEOA) continue;

                                const cPtransactions = await getAllTransactions(cp, cfg.chain_id);

                                if (cPtransactions.length < process.env.TRANSACTIONS_COUNT) {
                                    const cpHistory = await getWalletHistory(cp, cfg.chain);
                                    if (cpHistory !== 'TRANSACTIONS_COUNT_LIMIT') {


                                        const {swaps: allCpSwaps, transfers: allCpTransfers} =
                                            await createHistorySwaps(cfg, cp, cpHistory, usdPrice);

                                        const cpSwaps = allCpSwaps.filter(s =>
                                            s.bought.address?.toLowerCase() === contract.toLowerCase() ||
                                            s.sold.address?.toLowerCase() === contract.toLowerCase()
                                        );
                                        const cpTransfers = allCpTransfers.filter(t =>
                                            t.contract?.toLowerCase() === contract.toLowerCase()
                                        );

                                        const cpBuySwaps = cpSwaps.filter(s => s.transactionType === 'buy');

                                        const totalSentToParent = allCpTransfers
                                            .filter(t =>
                                                t.contract?.toLowerCase() === contract.toLowerCase() &&
                                                t.from?.toLowerCase() === cp &&
                                                t.to?.toLowerCase() === address.toLowerCase()
                                            )
                                            .reduce((sum, t) => sum + Math.abs(parseFloat(t.value)), 0);

                                        if (cpBuySwaps.length === 1 && totalSentToParent > 0) {
                                            const onlySwap = {...cpSwaps[0]};

                                            const originalEth = Math.abs(parseFloat(onlySwap.sold.amount));
                                            const originalBought = Math.abs(parseFloat(onlySwap.bought.amount));

                                            const ratio = totalSentToParent / originalBought;

                                            const newEth = originalEth * ratio;

                                            onlySwap.sold.amount = newEth.toString();
                                            onlySwap.bought.amount = totalSentToParent.toString();

                                            allSwaps.push(onlySwap);
                                            continue;
                                        }

                                        if (cpBuySwaps.length > 1 && totalSentToParent > 0) {
                                            const firstSwap = {...cpSwaps[0]};
                                            const firstBought = Math.abs(parseFloat(firstSwap.bought.amount));

                                            if (totalSentToParent >= firstBought) {

                                                const buySwaps = cpSwaps.filter(s => s.transactionType === 'buy');
                                                const sumBought = buySwaps.reduce((sum, s) =>
                                                    sum + Math.abs(parseFloat(s.bought.amount)), 0
                                                );

                                                const ratioAll = totalSentToParent / sumBought;

                                                buySwaps.forEach((s, idx) => {
                                                    const clone = {...s};
                                                    const origSold = Math.abs(parseFloat(clone.sold.amount));
                                                    const origBought = Math.abs(parseFloat(clone.bought.amount));

                                                    clone.sold.amount = (origSold * ratioAll).toString();
                                                    clone.bought.amount = (origBought * ratioAll).toString();

                                                    allSwaps.push(clone);
                                                });
                                            } else {
                                                const originalEth = Math.abs(parseFloat(firstSwap.sold.amount));
                                                const ratio = totalSentToParent / firstBought;

                                                const newEth = originalEth * ratio;

                                                firstSwap.sold.amount = newEth.toString();
                                                firstSwap.bought.amount = totalSentToParent.toString();

                                                allSwaps.push(firstSwap);
                                            }
                                            continue;
                                        }

                                        let outAmt = 0, inAmt = 0;
                                        allTransfers
                                            .filter(t => t.contract?.toLowerCase() === contract.toLowerCase())
                                            .forEach(t => {
                                                const v = Math.abs(parseFloat(t.value));
                                                if (['send', 'token send'].includes(t.category)) outAmt += v;
                                                if (['receive', 'token receive'].includes(t.category)) inAmt += v;
                                            });

                                        const spent = initialStats[contract].spent_token;
                                        const received = initialStats[contract].receive_token;

                                        const ratioOut = spent > 0 ? Math.min(1, outAmt / spent) : 0;
                                        const ratioIn = spent === 0 ? Math.min(1, inAmt / received) : 0;

                                        function matchSwapsByRatio(swaps, ratio, type) {
                                            const filtered = swaps.filter(s => s.transactionType === type);

                                            if (ratio === 1) {
                                                return filtered;
                                            }
                                            if (!filtered.length) {
                                                return [];
                                            }

                                            const total = filtered.reduce((sum, s) => {
                                                const amt = Math.abs(parseFloat(
                                                    type === 'sell' ? s.sold.amount : s.bought.amount
                                                ));
                                                return sum + amt;
                                            }, 0);

                                            let target = total * ratio, acc = 0;
                                            const sorted = filtered.sort((a, b) =>
                                                new Date(a.blockTimestamp) - new Date(b.blockTimestamp)
                                            );

                                            const result = [];
                                            for (const sw of sorted) {
                                                const amt = Math.abs(parseFloat(
                                                    type === 'sell' ? sw.sold.amount : sw.bought.amount
                                                ));
                                                if (amt >= target - acc) {
                                                    const clone = {...sw};
                                                    if (type === 'sell') clone.sold.amount = (target - acc).toString();
                                                    else clone.bought.amount = (target - acc).toString();
                                                    result.push(clone);
                                                    break;
                                                }
                                                result.push(sw);
                                                acc += amt;
                                            }

                                            if (!result.length) {
                                                const avg = (total * ratio) / filtered.length;
                                                const tpl = {...filtered[0]};
                                                if (type === 'sell') tpl.sold.amount = avg.toString();
                                                else tpl.bought.amount = avg.toString();
                                                return [tpl];
                                            }

                                            return result;
                                        }

                                        if (ratioOut > 0) {
                                            if (totalSentToParent > 0) {
                                                const matched = matchSwapsByRatio(cpSwaps, ratioOut, 'sell');
                                                allSwaps.push(...matched);
                                                if (ratioOut === 1) allTransfers.push(...cpTransfers);
                                            } else {
                                                allSwaps.push(...cpSwaps);
                                            }
                                        } else if (ratioIn > 0) {
                                            if (totalSentToParent > 0) {
                                                const matched = matchSwapsByRatio(cpSwaps, ratioIn, 'buy');
                                                allSwaps.push(...matched);
                                                if (ratioIn === 1) allTransfers.push(...cpTransfers);
                                            } else {
                                                allSwaps.push(...cpSwaps);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        const tokenData = {};
                        for (const swap of allSwaps) {
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
                                        spent_token: 0,
                                        received: 0,
                                        receive_token: 0,
                                        contractAddress: boughtAddress,
                                        pairAddress: bought.pairAddress,
                                        symbol: boughtSymbol,
                                        balance: 0,
                                        trades: []
                                    };
                                }
                                tokenData[token].spent += Math.abs(parseFloat(sold.amount));
                                tokenData[token].spent_token += Math.abs(parseFloat(bought.amount));
                                tokenData[token].trades.push(swap);
                            }

                            // Handle SELL transactions.
                            if (transactionType === 'sell' && soldAddress) {
                                const token = soldAddress.toLowerCase();

                                if (!tokenData[token]) {
                                    tokenData[token] = {
                                        spent: 0,
                                        spent_token: 0,
                                        received: 0,
                                        receive_token: 0,
                                        contractAddress: soldAddress,
                                        pairAddress: sold.pairAddress,
                                        symbol: soldSymbol,
                                        balance: 0,
                                        trades: [],
                                    };
                                }
                                tokenData[token].received += parseFloat(bought.amount);
                                tokenData[token].receive_token += Math.abs(parseFloat(sold.amount));
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
                        const associated_addresses = associatedAddresses(address, transactionsHistory, cfg);

                        // Get first transaction that include native token.
                        const firstTransaction = transactionsHistory.find(tx => tx.summary && tx.summary.includes(cfg.symbol));

                        // Add calculated data to JSON.
                        const addressData = {
                            chain_id: cfg.chain,
                            active_chains: activeChains,
                            performance_score: null,
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
                            let diffMinutes = null;

                            const pairStat = await getDexscreenerTokenPrice(contract, cfg.dexscreener_chain_id);

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
                                const v = Math.abs(parseFloat(transfer.value));
                                if (['send', 'token send'].includes(transfer.category)) {
                                    outflowCount++;
                                }
                                if (['receive', 'token receive'].includes(transfer.category)) {
                                    inflowCount++;
                                }
                            });


                            const avgHoldingHours = averageHoldingHours(stats.trades);
                            const earlyEntry = avgHoldingHours > 0 ? diffMinutes > 5 : null;

                            addressData.traded_tokens[contract] = {
                                symbol: stats.symbol,
                                spent: Number(stats.spent.toFixed(3)),
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
                } else {
                    await bot.sendMessage(chatId,
                        `Address is contract \n\`${address}\``,
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
