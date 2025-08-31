require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getWalletHistory,
    clearMoralisCache,
} = require('../../api/moralis');
const {getCode} = require('../../api/moralis-rpc');
const {
    getAllTransactions,
    getTokenTransfers,
    clearScanCache,
} = require('../../api/scan');
const {
    getDexscreenerTokenPrice,
    clearDexCache,
} = require('../../api/dexscreener');

const {
    createHistorySwaps,
    transactionsFrequency,
    associatedAddresses,
    averageHoldingHours,
    mergeVirtualTokens,
} = require('../../controlers');

const config = require('../../config.js');

function stringifyWithInline(obj, inlineKeys = ['pnl'], space = 2) {
    const START = '__INLINE__';
    const END = '__END__';

    const json = JSON.stringify(
        obj,
        (key, value) => {
            if (inlineKeys.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
                const pairs = Object.entries(value)
                    .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
                    .join(', ');
                return `${START}{ ${pairs} }${END}`;
            }
            return value;
        },
        space
    );

    return json.replace(new RegExp(`"${START}([\\s\\S]*?)${END}"`, 'g'), (_, inner) => {
        return JSON.parse(`"${inner}"`);
    });
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

                // console.debug('Moralis: Address code', code);

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
                            const contractLc = contract.toLowerCase();

                            const counterparties = [...new Set(
                                transfers
                                    .filter(t => t.contract?.toLowerCase() === contractLc)
                                    .map(t => (['send', 'token send'].includes(t.category) ? t.to : t.from))
                                    .filter(Boolean)
                                    .map(a => a.toLowerCase())
                            )];

                            if (counterparties.length === 1) {
                                const cp = counterparties[0];
                                const code = await getCode(cp, cfg.rpc_url, cfg.chain);
                                const isEOA = code === '0x' || code === '0x0';
                                if (!isEOA) continue;

                                const cPtransactions = await getAllTransactions(cp, cfg.chain_id);

                                if (cPtransactions.length < process.env.TRANSACTIONS_COUNT) {
                                    const cpTransactions = await getTokenTransfers(cp, contractLc, cfg.chain_id);
                                    let cpHistory = [];

                                    if (cpTransactions.length > 10) {
                                        cpHistory = await getWalletHistory(cp, cfg.chain);
                                    } else {
                                        for (const t of cpTransactions) {
                                            const hist = await getWalletHistory(cp, cfg.chain, Number(t.blockNumber), Number(t.blockNumber));
                                            if (hist.some(tx => tx.hash.toLowerCase() === t.hash.toLowerCase())) {
                                                cpHistory.push(hist[0]);
                                            }
                                        }
                                    }

                                    if (cpHistory !== 'TRANSACTIONS_COUNT_LIMIT') {
                                        const {swaps: allCpSwaps, transfers: allCpTransfers} =
                                            await createHistorySwaps(cfg, cp, cpHistory, usdPrice);

                                        const cpSwaps = allCpSwaps.filter(s =>
                                            s.bought.address?.toLowerCase() === contractLc ||
                                            s.sold.address?.toLowerCase() === contractLc
                                        );

                                        const rawCpTransfers = allCpTransfers.filter(t =>
                                            t.contract?.toLowerCase() === contractLc
                                        );

                                        const addrLc = address.toLowerCase();
                                        const cpLc = cp.toLowerCase();
                                        const getFrom = (t) => (t.from ?? t.from_address ?? '').toLowerCase();
                                        const getTo = (t) => (t.to ?? t.to_address ?? '').toLowerCase();

                                        const cpTransfers = rawCpTransfers
                                            .filter(t => getFrom(t) !== addrLc && getTo(t) !== addrLc)
                                            .map(t => {
                                                const clone = {...t};
                                                if (getFrom(t) === cpLc) clone.from = address;
                                                if (getTo(t) === cpLc) clone.to = address;
                                                return clone;
                                            });

                                        const totalSentToParent = allCpTransfers
                                            .filter(t =>
                                                t.contract?.toLowerCase() === contractLc &&
                                                getFrom(t) === cpLc &&
                                                getTo(t) === addrLc
                                            )
                                            .reduce((sum, t) => sum + Math.abs(parseFloat(t.value)), 0);

                                        const cpBuySwaps = cpSwaps.filter(s => s.transactionType === 'buy');

                                        if (cpBuySwaps.length === 1 && totalSentToParent > 0) {
                                            const onlySwap = {...cpSwaps[0]};
                                            const originalEth = Math.abs(parseFloat(onlySwap.sold.amount));
                                            const originalBought = Math.abs(parseFloat(onlySwap.bought.amount));
                                            const ratio = totalSentToParent / originalBought;
                                            const newEth = originalEth * ratio;

                                            onlySwap.sold.amount = newEth.toString();
                                            onlySwap.bought.amount = totalSentToParent.toString();

                                            allSwaps.push(onlySwap);
                                            allTransfers.push(...cpTransfers);
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

                                                buySwaps.forEach(s => {
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
                                            allTransfers.push(...cpTransfers);
                                            continue;
                                        }

                                        let outAmt = 0, inAmt = 0;
                                        allTransfers
                                            .filter(t => t.contract?.toLowerCase() === contractLc)
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
                                            if (ratio === 1) return filtered;
                                            if (!filtered.length) return [];

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
                                                allTransfers.push(...cpTransfers);
                                            } else {
                                                allSwaps.push(...cpSwaps);
                                                allTransfers.push(...cpTransfers);
                                            }
                                        } else if (ratioIn > 0) {
                                            if (totalSentToParent > 0) {
                                                const matched = matchSwapsByRatio(cpSwaps, ratioIn, 'buy');
                                                allSwaps.push(...matched);
                                                allTransfers.push(...cpTransfers);
                                            } else {
                                                allSwaps.push(...cpSwaps);
                                                allTransfers.push(...cpTransfers);
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
                            const boughtAddress = bought.address?.toLowerCase();
                            const soldAddress = sold.address?.toLowerCase();

                            const boughtStable = cfg.stable_coins.includes(boughtAddress);
                            const soldStable = cfg.stable_coins.includes(soldAddress);

                            if (boughtStable && soldStable) continue;

                            if (
                                (boughtStable && soldSymbol !== cfg.trade_symbol) ||
                                (soldStable && boughtSymbol !== cfg.trade_symbol)
                            ) {
                                continue;
                            }

                            if (
                                (boughtStable && soldSymbol !== cfg.symbol) ||
                                (soldStable && boughtSymbol !== cfg.symbol)
                            ) {
                                continue;
                            }

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
                                usdValue = amount * Number(data?.priceUsd || 0);
                            }

                            tokenData[addr].balance = usdValue / usdPrice;
                        }

                        // Remove tokens with no inflow and no trades.
                        for (const [contract, stats] of Object.entries(tokenData)) {
                            const inflowCount = allTransfers.filter(t => t.category === 'receive' || t.category === 'token receive').length;

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
                        if (cfg.chain === 'base') mergeVirtualTokens(tokenData);

                        // Get transaction frequency for address.
                        const transaction_frequency = transactionsFrequency(address, transactionsHistory);

                        // Get associated addresses.
                        const associated_addresses = await associatedAddresses(address, transactionsHistory, cfg);

                        // Get first transaction that include native token.
                        const firstTransaction = transactionsHistory.find(tx => tx.summary && tx.summary.includes(cfg.symbol));

                        // Add calculated data to JSON.
                        const addressData = {
                            chain_id: cfg.chain,
                            active_chains: activeChains,
                            performance_score: null,
                            average_pnl: '',
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

                        const isEOAAddress = async (addr) => {
                            try {
                                const c = await getCode(addr, cfg.rpc_url, cfg.chain);
                                return (c === '0x' || c === '0x0');
                            } catch (e) {
                                return true;
                            }
                        };

                        for (const [contract, stats] of Object.entries(tokenData)) {
                            let inflowCount = 0;
                            let outflowCount = 0;
                            let diffMinutes = null;

                            const pairStat = await getDexscreenerTokenPrice(contract, cfg.dexscreener_chain_id);

                            if (Array.isArray(stats.trades) && stats.trades.length > 0) {
                                const sortedTrades = stats.trades.slice().sort(
                                    (a, b) => new Date(a.blockTimestamp) - new Date(b.blockTimestamp)
                                );
                                const firstTrade = sortedTrades[0];

                                const createdTime = new Date(pairStat?.pairCreatedAt);
                                const firstBuyTime = new Date(firstTrade.blockTimestamp);

                                diffMinutes = pairStat?.pairCreatedAt && Math.round((firstBuyTime - createdTime) / (1000 * 60));
                            }

                            const realizedPnl = stats.balance + (stats.received - stats.spent);

                            const allTokenContracts = [contract.toLowerCase()];

                            if (stats.same_contracts) {
                                allTokenContracts.push(...Object.keys(stats.same_contracts).map(c => c));
                            }

                            const tokenTransfers = allTransfers.filter(i => allTokenContracts.includes(i.contract));

                            const buyCount = stats.trades.filter(trade => trade.transactionType === 'buy').length;
                            const sellCount = stats.trades.filter(trade => trade.transactionType === 'sell').length;

                            sumRealizedPnls += realizedPnl;
                            tokenCount++;

                            const roiPctToken = stats.spent > 0
                                ? Number(((realizedPnl / stats.spent) * 100).toFixed(2))
                                : null;

                            const isProfitable = stats.spent > 0 ? realizedPnl > 0 : null;

                            // Count transfer directions and sum token amounts
                            let transferInAmountToken = 0;
                            let transferOutAmountToken = 0;
                            let hasContractTransfer = false;

                            for (const transfer of tokenTransfers) {
                                const v = Math.abs(parseFloat(transfer.value));
                                if (['send', 'token send'].includes(transfer.category)) {
                                    outflowCount++;
                                    transferOutAmountToken += v;
                                }
                                if (['receive', 'token receive'].includes(transfer.category)) {
                                    inflowCount++;
                                    transferInAmountToken += v;
                                }
                            }

                            // CONTRACT_TRANSFERS check (any outgoing transfer to contract)
                            // Check unique 'to' recipients for outflow
                            const outRecipients = [...new Set(
                                tokenTransfers
                                    .filter(t => ['send', 'token send'].includes(t.category))
                                    .map(t => (t.to || '').toLowerCase())
                                    .filter(Boolean)
                            )];

                            for (const toAddr of outRecipients) {
                                const eoa = await isEOAAddress(toAddr);
                                if (!eoa) { // it is a contract
                                    hasContractTransfer = true;
                                    break;
                                }
                            }

                            const totalTransferredToken = transferInAmountToken + transferOutAmountToken;
                            const totalSwappedToken = (stats.spent_token || 0) + (stats.receive_token || 0);
                            let unmatchedTransfersFlag = false;
                            if (totalTransferredToken > 0) {
                                const coverage = Math.min(totalSwappedToken, totalTransferredToken) / totalTransferredToken;
                                if (coverage < 0.75) unmatchedTransfersFlag = true;
                            }

                            const avgHoldingHours = averageHoldingHours(stats.trades);
                            const n = diffMinutes == null ? null : Number(diffMinutes);

                            const earlyEntry = n == null ? null : n <= 5;

                            let include = true;
                            let exclude_reason = undefined;

                            if (stats.spent === 0) {
                                include = false;
                                exclude_reason = 'ZERO_COST_BASIS';
                            } else if (stats.spent < cfg.dust_spent_filter) {
                                include = false;
                                exclude_reason = 'DUST_SPENT';
                            } else if (unmatchedTransfersFlag) {
                                include = false;
                                exclude_reason = 'UNMATCHED_TRANSFERS';
                            } else if (hasContractTransfer) {
                                include = false;
                                exclude_reason = 'CONTRACT_TRANSFERS';
                            } else if (
                                Math.abs(realizedPnl) > cfg.mistake_data_filter ||
                                Math.abs(stats.received) > cfg.mistake_data_filter ||
                                Math.abs(stats.balance) > cfg.mistake_data_filter
                            ) {
                                include = false;
                                exclude_reason = 'DATA_MISTAKE';
                            }

                            addressData.traded_tokens[contract] = {
                                symbol: stats.symbol,
                                spent: Number(stats.spent.toFixed(3)),
                                roi_pct_token: roiPctToken,
                                is_profitable: isProfitable,
                                pnl: {
                                    total: Number(realizedPnl.toFixed(2)),
                                    realized: Number(stats.received.toFixed(2)),
                                    unrealized: Number(stats.balance.toFixed(2)),
                                },
                                avg_holding_hours: avgHoldingHours,
                                minutes_after_launch_to_buy: diffMinutes,
                                early_entry: earlyEntry,
                                transfers: {
                                    inflow_count: inflowCount,
                                    outflow_count: outflowCount,
                                },
                                include,
                                ...(include === false ? {exclude_reason} : {}),
                                trades: {
                                    buy_count: buyCount,
                                    sell_count: sellCount,
                                },
                                ...(stats.same_contracts) && {
                                    same_contracts: stats.same_contracts,
                                }
                            };
                        }

                        const overallAverage = tokenCount ? sumRealizedPnls / tokenCount : 0;

                        addressData.average_pnl = Number(overallAverage.toFixed(2));

                        // ====== Use only included tokens for performance score ======
                        const ROI_CAP_HI = 1500;
                        const ROI_CAP_LO = -100;
                        const EPS_MEAN = 1e-6;
                        const round2 = x => Math.round(x * 100) / 100;

                        function roiConsistencyScore(traded_tokens) {
                            if (!traded_tokens) return null;

                            const rois = Object.values(traded_tokens)
                                .filter(t => t?.include === true && Number(t?.spent) > 0)
                                .map(t => (Number(t.pnl?.total || 0) / Number(t.spent)) * 100)
                                .filter(v => Number.isFinite(v))
                                .map(v => Math.min(ROI_CAP_HI, Math.max(ROI_CAP_LO, v)));

                            if (rois.length < 2) return null;

                            const mean = rois.reduce((s, x) => s + x, 0) / rois.length;
                            if (Math.abs(mean) < EPS_MEAN) return null;

                            const variance = rois.reduce((s, x) => s + (x - mean) ** 2, 0) / (rois.length - 1);
                            const sd = Math.sqrt(variance);
                            const cv = sd / Math.abs(mean);
                            const score = 10 * (1 / (1 + cv));
                            return round2(Math.max(0, Math.min(10, score)));
                        }

                        const tokens = Object.entries(addressData.traded_tokens || {})
                            .map(([contract, v]) => ({contract, ...v}));
                        const includedTokens = tokens.filter(t => t.include === true);
                        const includedWithSpend = includedTokens.filter(t => Number(t.spent) > 0);

                        const token_accuracy_pct = includedTokens.length
                            ? round2((includedTokens.filter(t => Number(t.pnl?.total) > 0).length / includedTokens.length) * 100)
                            : null;

                        const sumSpent = includedWithSpend.reduce((s, t) => s + Number(t.spent || 0), 0);
                        const sumPnL = includedWithSpend.reduce((s, t) => s + Number(t.pnl?.total || 0), 0);
                        const weighted_roi_pct = sumSpent > 0 ? round2((sumPnL / sumSpent) * 100) : null;

                        const roi_consistency_score = roiConsistencyScore(addressData.traded_tokens);

                        const n_tokens_included = includedWithSpend.length;

                        const avg_token_roi_pct = includedWithSpend.length
                            ? round2(
                                includedWithSpend.reduce(
                                    (sum, t) => sum + ((Number(t.pnl?.total || 0) / Number(t.spent)) * 100),
                                    0
                                ) / includedWithSpend.length
                            )
                            : null;

                        addressData.performance_score = {
                            token_accuracy_pct,
                            weighted_roi_pct,
                            roi_consistency_score,
                            n_tokens_included,
                            avg_token_roi_pct
                        };

                        addressData.scoring_scope = {
                            included_tokens: includedTokens.map(t => t.contract),
                            excluded_tokens: tokens.filter(t => t.include === false).map(t => t.contract),
                        };


                        // Save result for this chain
                        chainResults[chainKey] = addressData;

                        const filePath = `${addressData.average_pnl}${cfg.symbol.toLowerCase()} - ${address}.json`;

                        fs.writeFileSync(filePath, stringifyWithInline({[address]: addressData}, ['pnl', 'transfers', 'trades'], 2));

                        await bot.sendDocument(chatId, filePath, {caption: `\`${address}\``, parse_mode: 'Markdown'});

                        fs.unlinkSync(filePath);

                        clearMoralisCache();
                        clearScanCache();
                        clearDexCache();
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
