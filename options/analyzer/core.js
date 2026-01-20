require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {logger} = require('../../performanceLogger');

const {
    getWalletTokenBalances,
    getActiveWalletChains,
    getTokenPrice,
    getTokenPricesBatch,      // <-- Є, але тепер реально викликаємо
    prefetchTokenPrices,       // <-- залишив як було (структуру не чіпаю)
    getWalletHistory,
    clearMoralisCache,
} = require('../../api/moralis');
const {getCode, prefetchAddresses, clearCodeCache} = require('../../api/moralis-rpc');
const {
    getAllTransactions,
    getTokenTransfers,
    clearScanCache,
} = require('../../api/scan');
const {
    getDexscreenerTokenPrice,
    getDexscreenerTokenPricesBatch,
    prefetchDexscreenerPrices,
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
const {stringifyWithInline} = require("./services/stringifyWithInline");
const {getOldestBuyTimestamp} = require("./services/getOldestBuyTimestamp");
const {formatUnitsManual} = require("./services/formatUnitsManual");

// Blacklist проблемних адрес що викликають timeout/помилки
const BLACKLISTED_ADDRESSES = new Set([
    '0x000000000000000000000000000000000000dead',
    '0x0000000000000000000000000000000000000000',
]);

const walletParserCore = async (addresses, bot, chatId, chainsToProcess) => {
    const splitAddresses = addresses.split('\n');
    const clusterStatsCache = {};

    logger.logInfo(`Starting batch processing of ${splitAddresses.length} addresses`);

    for (const address of splitAddresses) {
        // ========== START ADDRESS PROCESSING ==========
        logger.startAddress(address);

        try {
            // Skip ERC-4337 EntryPoint addresses
            if (address.toLowerCase().startsWith('0x4337')) {
                logger.logWarning('ERC-4337 EntryPoint address, skipping');
                await bot.sendMessage(chatId,
                    `ERC4337  address \n\`${address}\``,
                    {parse_mode: 'MarkdownV2'}
                );
                logger.endAddress(address);
                continue;
            }

            // ========== STAGE 1: Get Active Chains ==========
            logger.logStage('STAGE 1: Getting active chains');
            const activeChains = await getActiveWalletChains(address);
            const chains = chainsToProcess.length === 1 ? chainsToProcess : activeChains;
            logger.logInfo(`Processing chains: ${chains.join(', ')}`);

            const chainResults = {};
            for (const chainKey of chains) {
                const cfg = config[chainKey];
                if (!cfg) {
                    logger.logWarning(`No config for chain: ${chainKey}`);
                    continue;
                }

                logger.logStage(`STAGE 2: Processing chain ${chainKey}`);

                // ========== STAGE 2.1: Check if EOA ==========
                logger.logStage('STAGE 2.1: Checking if address is EOA');
                const isAddress = await getCode(address, cfg.rpc_url, cfg.chain);

                if (isAddress) {
                    // ========== STAGE 2.2: Get all transactions ==========
                    logger.logStage('STAGE 2.2: Getting all transactions from Scan');
                    const transactions = await getAllTransactions(address, cfg.chain_id);

                    if (transactions.length < process.env.SCAN_TRANSACTIONS_COUNT) {
                        // ========== STAGE 2.3: Get wallet history ==========
                        logger.logStage('STAGE 2.3: Getting wallet history from Moralis');
                        const transactionsHistory = await getWalletHistory(address, cfg.chain);

                        if (transactionsHistory === 'TRANSACTIONS_COUNT_LIMIT') {
                            logger.logWarning('Transaction count limit exceeded');
                            await bot.sendMessage(chatId,
                                `Transactions count address more then ${process.env.SCAN_TRANSACTIONS_COUNT} \n\`${address}\``,
                                {parse_mode: 'MarkdownV2'}
                            );
                            continue;
                        }

                        // ========== STAGE 2.4: Get native token price ==========
                        logger.logStage('STAGE 2.4: Getting native token price');
                        const {usdPrice} = await getTokenPrice(cfg.contract, cfg.chain);

                        // ========== STAGE 2.5: Get token balances ==========
                        logger.logStage('STAGE 2.5: Getting token balances');
                        const balances = await getWalletTokenBalances(address, cfg.chain);

                        // ========== STAGE 2.5.5: BATCH PREFETCH Moralis token prices ==========
                        // НЕ змінюю структуру — тільки додаю реальний виклик getTokenPricesBatch
                        logger.logStage('STAGE 2.5.5: Prefetching Moralis token prices for swap processing');
                        const prefetchPriceTimer = logger.createTimer('moralisPricePrefetch');

                        const tokenAddressesForPricePrefetch = new Set();

                        // Локальний helper: без зміни зовнішньої структури
                        const pickTokenAddr = (obj) => (
                            obj?.token_address ||
                            obj?.tokenAddress ||
                            obj?.address ||
                            obj?.contract_address ||
                            obj?.contractAddress ||
                            obj?.token?.address ||
                            obj?.tokenAddress?.address ||
                            obj?.tokenAddress?.token_address
                        );

                        // Збираємо токени з transactionsHistory
                        for (const tx of transactionsHistory) {
                            // З erc20_transfers
                            if (tx.erc20_transfers) {
                                for (const et of tx.erc20_transfers) {
                                    const a = pickTokenAddr(et);
                                    if (a) tokenAddressesForPricePrefetch.add(String(a).toLowerCase());
                                }
                            }

                            // З native_transfers
                            if (tx.native_transfers) {
                                for (const nt of tx.native_transfers) {
                                    const a = pickTokenAddr(nt) || nt?.token_address;
                                    if (a) tokenAddressesForPricePrefetch.add(String(a).toLowerCase());
                                }
                            }

                            // З summary (витягуємо адреси токенів)
                            if (tx.summary) {
                                const matches = tx.summary.match(/0x[a-fA-F0-9]{40}/g);
                                if (matches) {
                                    matches.forEach(addr => tokenAddressesForPricePrefetch.add(addr.toLowerCase()));
                                }
                            }
                        }

                        // Видаляємо native token, stablecoins та excluded
                        tokenAddressesForPricePrefetch.delete(cfg.contract.toLowerCase());
                        for (const stable of cfg.stable_coins) {
                            tokenAddressesForPricePrefetch.delete(stable.toLowerCase());
                        }
                        for (const excluded of cfg.excluded_contracts) {
                            tokenAddressesForPricePrefetch.delete(excluded.toLowerCase());
                        }

                        // Логи щоб 100% бачити що batch викликається/не викликається
                        logger.logInfo(`Moralis prefetch candidates: ${tokenAddressesForPricePrefetch.size}`);

                        // ГОЛОВНЕ: batch виклик (а не тільки prefetchTokenPrices)
                        if (tokenAddressesForPricePrefetch.size > 0) {
                            await getTokenPricesBatch([...tokenAddressesForPricePrefetch], cfg.chain);
                            logger.logInfo(`Batch prefetched Moralis prices for ${tokenAddressesForPricePrefetch.size} tokens`);
                        }

                        prefetchPriceTimer.stop();

                        // ========== STAGE 2.6: Create history swaps ==========
                        logger.logStage('STAGE 2.6: Creating history swaps', `${transactionsHistory.length} transactions`);
                        const swapTimer = logger.createTimer('createHistorySwaps');
                        const {
                            swaps,
                            transfers
                        } = await createHistorySwaps(cfg, address, transactionsHistory, usdPrice);
                        swapTimer.stop();
                        logger.logInfo(`Found ${swaps.length} swaps, ${transfers.length} transfers`);

                        // ========== STAGE 2.7: Prefetch addresses ==========
                        logger.logStage('STAGE 2.7: Prefetching counterparty addresses');
                        const addressesToPrefetch = new Set();
                        for (const t of transfers) {
                            if (t.from) addressesToPrefetch.add(t.from);
                            if (t.to) addressesToPrefetch.add(t.to);
                            if (t.from_address) addressesToPrefetch.add(t.from_address);
                            if (t.to_address) addressesToPrefetch.add(t.to_address);
                        }

                        // Видаляємо blacklisted адреси
                        for (const blacklisted of BLACKLISTED_ADDRESSES) {
                            addressesToPrefetch.delete(blacklisted);
                        }

                        await prefetchAddresses([...addressesToPrefetch], cfg.rpc_url, cfg.chain);

                        let allSwaps = [...swaps];
                        let allTransfers = [...transfers];
                        const initialStats = {};
                        const contractGroupMap = {};

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

                        // ========== STAGE 2.8: Process counterparties ==========
                        logger.logStage('STAGE 2.8: Processing counterparties', `${Object.keys(initialStats).length} contracts`);
                        const thirdPartyCpTransfers = new Set();
                        const cpsCountByContract = new Map();
                        const cpBalancesByToken = {};

                        let cpProcessedCount = 0;
                        const totalContracts = Object.keys(initialStats).length;

                        for (const [contract] of Object.entries(initialStats)) {
                            cpProcessedCount++;
                            const contractLc = contract.toLowerCase();

                            if (cpProcessedCount % 10 === 0 || cpProcessedCount === totalContracts) {
                                logger.logInfo(`Processing contract ${cpProcessedCount}/${totalContracts}`);
                            }

                            const counterparties = [...new Set(
                                transfers
                                    .filter(t => t.contract?.toLowerCase() === contractLc)
                                    .map(t => (['send', 'token send'].includes(t.category) ? t.to : t.from))
                                    .filter(Boolean)
                                    .map(a => a.toLowerCase())
                                    .filter(a => !BLACKLISTED_ADDRESSES.has(a)) // Фільтруємо blacklisted
                            )];

                            const checks = await Promise.all(
                                counterparties.map(async cp => {
                                    return await getCode(cp, cfg.rpc_url, cfg.chain);
                                })
                            );

                            const cpsCount = checks.filter(x => x).length;
                            cpsCountByContract.set(contractLc, cpsCount);

                            if (cpsCount === 1) {
                                const cp = counterparties[0];

                                // Skip blacklisted addresses
                                if (BLACKLISTED_ADDRESSES.has(cp.toLowerCase())) {
                                    logger.logInfo(`Skipping blacklisted counterparty: ${cp}`);
                                    continue;
                                }

                                const isEOA = await getCode(cp, cfg.rpc_url, cfg.chain);
                                if (!isEOA) continue;

                                const cPtransactions = await getAllTransactions(cp, cfg.chain_id);
                                const cpBalances = await getWalletTokenBalances(cp, cfg.chain);

                                const cpTokenBalance = cpBalances.find(
                                    b => b.token_address?.toLowerCase() === contractLc
                                );

                                if (cpTokenBalance) {
                                    cpBalancesByToken[contractLc] = cpTokenBalance?.usd_value / usdPrice;
                                }

                                if (cPtransactions.length < process.env.SCAN_TRANSACTIONS_COUNT) {
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

                                        if (cpTransfers.length > 0) {
                                            thirdPartyCpTransfers.add(contractLc);
                                        }

                                        const totalSentToParent = allCpTransfers
                                            .filter(t =>
                                                t.contract?.toLowerCase() === contractLc &&
                                                getFrom(t) === cpLc &&
                                                getTo(t) === addrLc
                                            )
                                            .reduce((sum, t) => sum + Math.abs(parseFloat(t.value)), 0);

                                        const cpBuySwaps = cpSwaps.filter(s => s.transactionType === 'buy');

                                        if (cpBuySwaps.length === 1 && totalSentToParent > 0) {
                                            const onlySwap = {...cpBuySwaps[0]};
                                            const originalEth = Math.abs(parseFloat(onlySwap.sold.amount));
                                            const originalBought = Math.abs(parseFloat(onlySwap.bought.amount));
                                            const ratio = totalSentToParent / originalBought;
                                            const newEth = originalEth * ratio;

                                            onlySwap.sold.amount = newEth.toString();
                                            onlySwap.bought.amount = totalSentToParent.toString();

                                            allSwaps.push(onlySwap);
                                            allTransfers.push(...cpTransfers);
                                            const groupId = `${cfg.chain}|${contractLc}|${[addrLc, cpLc].sort().join('|')}`;
                                            contractGroupMap[contractLc] = groupId;
                                            continue;
                                        }

                                        if (cpBuySwaps.length > 1 && totalSentToParent > 0) {
                                            const firstSwap = {...cpBuySwaps[0]};
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
                                            const groupId = `${cfg.chain}|${contractLc}|${[addrLc, cpLc].sort().join('|')}`;
                                            contractGroupMap[contractLc] = groupId;
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
                                        const received = Math.abs(initialStats[contract].receive_token);

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
                                            const groupId = `${cfg.chain}|${contractLc}|${[addrLc, cpLc].sort().join('|')}`;
                                            contractGroupMap[contractLc] = groupId;
                                        } else if (ratioIn > 0) {
                                            if (totalSentToParent > 0) {
                                                const matched = matchSwapsByRatio(cpSwaps, ratioIn, 'buy');
                                                allSwaps.push(...matched);
                                                allTransfers.push(...cpTransfers);
                                            } else {
                                                allSwaps.push(...cpSwaps);
                                                allTransfers.push(...cpTransfers);
                                            }
                                            const groupId = `${cfg.chain}|${contractLc}|${[addrLc, cpLc].sort().join('|')}`;
                                            contractGroupMap[contractLc] = groupId;
                                        }
                                    }
                                }
                            }
                        }

                        // ========== STAGE 2.9: Dedupe swaps and transfers ==========
                        logger.logStage('STAGE 2.9: Deduplicating swaps and transfers');
                        const dedupeTimer = logger.createTimer('dedupe');

                        const dedupeSwaps = (swapsArr) => {
                            const byKey = new Map();
                            const magnitude = (x) => {
                                const b = Math.abs(parseFloat(x?.bought?.amount ?? 0));
                                const s = Math.abs(parseFloat(x?.sold?.amount ?? 0));
                                return b + s;
                            };
                            for (const s of swapsArr) {
                                const key = (s.transactionHash || s.hash || `${s.blockTimestamp}-${s.summary || ''}`).toLowerCase();
                                const prev = byKey.get(key);
                                if (!prev || magnitude(s) > magnitude(prev)) byKey.set(key, s);
                            }
                            return Array.from(byKey.values());
                        };

                        const dedupeTransfers = (transfersArr) => {
                            const seen = new Set();
                            const out = [];
                            for (const t of transfersArr) {
                                const key = [
                                    (t.transactionHash || t.hash || '').toLowerCase(),
                                    (t.contract || '').toLowerCase(),
                                    (t.from || t.from_address || '').toLowerCase(),
                                    (t.to || t.to_address || '').toLowerCase(),
                                    String(t.value)
                                ].join('|');
                                if (seen.has(key)) continue;
                                seen.add(key);
                                out.push(t);
                            }
                            return out;
                        };

                        const beforeDedupeSwaps = allSwaps.length;
                        const beforeDedupeTransfers = allTransfers.length;
                        allSwaps = dedupeSwaps(allSwaps);
                        allTransfers = dedupeTransfers(allTransfers);
                        dedupeTimer.stop();
                        logger.logInfo(`Swaps: ${beforeDedupeSwaps} -> ${allSwaps.length}, Transfers: ${beforeDedupeTransfers} -> ${allTransfers.length}`);

                        // Debug logging for specific transactions
                        const targetHashes = [
                            '0x9ead214cdd634f54ba3dab21e6bb1de562d44d3603c78ea21ee13b1549bb571e',
                            '0x97c8656c34ae63e64ce8c6414205e3fe8867d63e38ae253fa4061b42612362cb',
                        ];

                        const lowerCaseHashes = targetHashes.map(h => h.toLowerCase());

                        const matchingTransactions = swaps.filter(tx =>
                            lowerCaseHashes.includes(tx.transactionHash.toLowerCase())
                        );

                        matchingTransactions.forEach(tx => {
                            console.log('tx', tx);
                        });

                        // ========== STAGE 2.10: Build token data ==========
                        logger.logStage('STAGE 2.10: Building token data');
                        const tokenDataTimer = logger.createTimer('buildTokenData');

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
                        tokenDataTimer.stop();
                        logger.logInfo(`Built data for ${Object.keys(tokenData).length} tokens`);

                        // ========== STAGE 2.10.5: BATCH PREFETCH Dexscreener prices ==========
                        logger.logStage('STAGE 2.10.5: Batch prefetching Dexscreener prices');
                        const prefetchTimer = logger.createTimer('dexscreenerPrefetch');

                        // Збираємо всі адреси токенів для batch prefetch
                        const allTokenAddressesForDex = new Set();

                        // Токени з balances які потребують ціни
                        for (const token of balances) {
                            if (token.token_address && tokenData[token.token_address]) {
                                if (!token.usd_value || token.usd_value === 0) {
                                    allTokenAddressesForDex.add(token.token_address.toLowerCase());
                                }
                            }
                        }

                        // Всі токени з tokenData
                        for (const contract of Object.keys(tokenData)) {
                            allTokenAddressesForDex.add(contract.toLowerCase());
                        }

                        // Один batch запит замість багатьох окремих!
                        let dexPricesMap = new Map();
                        if (allTokenAddressesForDex.size > 0) {
                            dexPricesMap = await getDexscreenerTokenPricesBatch(
                                [...allTokenAddressesForDex],
                                cfg.dexscreener_chain_id
                            );
                            logger.logInfo(`Batch prefetched ${allTokenAddressesForDex.size} token prices`);
                        }
                        prefetchTimer.stop();

                        // ========== STAGE 2.11: Convert balances to native token ==========
                        logger.logStage('STAGE 2.11: Converting balances to native token equivalents');
                        const balanceTimer = logger.createTimer('convertBalances');

                        for (const token of balances) {
                            const addr = token.token_address?.toLowerCase();
                            if (!tokenData[addr]) continue;

                            const amountStr = formatUnitsManual(token.balance, token.decimals);
                            const amount = parseFloat(amountStr);

                            let usdValue = token.usd_value;
                            if (!usdValue || usdValue === 0) {
                                // Тепер це миттєво - дані вже в кеші!
                                const data = dexPricesMap.get(addr) || await getDexscreenerTokenPrice(addr, cfg.dexscreener_chain_id);
                                usdValue = amount * Number(data?.priceUsd || 0);
                            }

                            tokenData[addr].balance = usdValue / usdPrice;
                        }

                        for (const [contractAddr, cpBalance] of Object.entries(cpBalancesByToken)) {
                            if (tokenData[contractAddr]) {
                                tokenData[contractAddr].balance += cpBalance;
                            }
                        }
                        balanceTimer.stop();

                        // Remove tokens with no inflow and no trades
                        for (const [contract, stats] of Object.entries(tokenData)) {
                            const inflowCount = allTransfers
                                .filter(t =>
                                    (t.contract?.toLowerCase() === contract) &&
                                    (t.category === 'receive' || t.category === 'token receive')
                                ).length;

                            const buyCount = stats.trades.filter(trade => trade.transactionType === 'buy').length;
                            const sellCount = stats.trades.filter(trade => trade.transactionType === 'sell').length;

                            if (inflowCount > 0 && buyCount === 0 && sellCount === 0) {
                                delete tokenData[contract];
                            }
                        }

                        // Filter traded tokens
                        for (const token of [...cfg.excluded_contracts, address]) {
                            const lowerToken = token.toLowerCase();
                            if (tokenData[lowerToken]) {
                                delete tokenData[lowerToken];
                            }
                        }

                        // Merge virtual tokens
                        if (cfg.chain === 'base') mergeVirtualTokens(tokenData);

                        // ========== STAGE 2.12: Calculate metrics ==========
                        logger.logStage('STAGE 2.12: Calculating transaction frequency and associated addresses');
                        const transaction_frequency = transactionsFrequency(address, transactionsHistory, swaps);
                        const associated_addresses = await associatedAddresses(address, transactionsHistory, cfg);

                        const firstTransaction = transactionsHistory.find(tx => tx.summary && tx.summary.includes(cfg.symbol));

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

                        // ========== STAGE 2.13: Process each token ==========
                        logger.logStage('STAGE 2.13: Processing individual tokens', `${Object.keys(tokenData).length} tokens`);
                        const tokenProcessTimer = logger.createTimer('processTokens');

                        let sumIncludedPnls = 0;
                        let includedTokenCount = 0;
                        let tokenProcessedCount = 0;
                        const totalTokens = Object.keys(tokenData).length;

                        for (const [contract, stats] of Object.entries(tokenData)) {
                            tokenProcessedCount++;
                            if (tokenProcessedCount % 20 === 0 || tokenProcessedCount === totalTokens) {
                                logger.logInfo(`Processing token ${tokenProcessedCount}/${totalTokens}`);
                            }

                            let inflowCount = 0;
                            let outflowCount = 0;
                            let diffMinutes = null;

                            // Тепер це миттєво - дані вже в кеші від batch prefetch!
                            const pairStat = dexPricesMap.get(contract.toLowerCase()) ||
                                await getDexscreenerTokenPrice(contract, cfg.dexscreener_chain_id);

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

                            if (buyCount === 0) {
                                diffMinutes = null;
                            }

                            const roiPctToken = stats.spent > 0
                                ? Number(((realizedPnl / stats.spent) * 100).toFixed(2))
                                : null;

                            const isProfitable = stats.spent > 0 ? realizedPnl > 0 : null;

                            let tokenInTransferToContract = 0;
                            let tokenOutTransferToContract = 0;

                            let hasContractTransfer = false;

                            for (const transfer of tokenTransfers) {
                                const v = Math.abs(parseFloat(transfer.value));
                                if (['send', 'token send'].includes(transfer.category)) {
                                    outflowCount++;

                                    const isAddress = await getCode(transfer.from, cfg.rpc_url, cfg.chain);
                                    if (!isAddress) {
                                        tokenOutTransferToContract += v;
                                    }
                                }
                                if (['receive', 'token receive'].includes(transfer.category)) {
                                    inflowCount++;

                                    const isAddress = await getCode(transfer.from, cfg.rpc_url, cfg.chain);
                                    if (!isAddress) {
                                        tokenInTransferToContract += v;
                                    }
                                }
                            }

                            const outRecipients = [...new Set(
                                tokenTransfers
                                    .filter(t => ['send', 'token send'].includes(t.category))
                                    .map(t => (t.to || '').toLowerCase())
                                    .filter(Boolean)
                            )];

                            for (const toAddr of outRecipients) {
                                const eoa = await getCode(toAddr, cfg.rpc_url, cfg.chain);
                                if (!eoa) {
                                    hasContractTransfer = true;
                                    break;
                                }
                            }

                            let unmatchedTransfersFlag = false;

                            const threshold = tokenInTransferToContract * 0.75;
                            const includeTransaction = tokenOutTransferToContract <= threshold && (tokenInTransferToContract > 0 || tokenOutTransferToContract > 0);

                            const cps = cpsCountByContract.get(contract.toLowerCase()) ?? 0;

                            if (cps > 1 || thirdPartyCpTransfers.has(contract.toLowerCase()) || includeTransaction) {
                                unmatchedTransfersFlag = true;
                            }

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

                            if (include === true) {
                                sumIncludedPnls += realizedPnl;
                                includedTokenCount++;
                            }

                            const avgHoldingHours = averageHoldingHours(stats.trades);
                            const n = diffMinutes == null ? null : Number(diffMinutes);
                            const earlyEntry = n == null ? null : n <= 5;
                            const firstBuyTs = getOldestBuyTimestamp(stats.trades);

                            const tokenEntry = {
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
                                first_buy_ts: firstBuyTs,
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

                            const gid = contractGroupMap[contract.toLowerCase()];
                            if (gid && clusterStatsCache[gid]) {
                                addressData.traded_tokens[contract] = JSON.parse(JSON.stringify(clusterStatsCache[gid]));
                            } else {
                                addressData.traded_tokens[contract] = tokenEntry;
                                if (gid) {
                                    clusterStatsCache[gid] = JSON.parse(JSON.stringify(tokenEntry));
                                }
                            }
                        }
                        tokenProcessTimer.stop();

                        // ========== STAGE 2.14: Calculate performance score ==========
                        logger.logStage('STAGE 2.14: Calculating performance score');

                        const overallAverageIncluded = includedTokenCount
                            ? (sumIncludedPnls / includedTokenCount)
                            : 0;

                        addressData.average_pnl = Number(overallAverageIncluded.toFixed(2));

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

                        logger.logInfo(`Performance: ${includedTokenCount} included tokens, avg PnL: ${addressData.average_pnl}`);

                        // ========== STAGE 2.15: Save and send results ==========
                        logger.logStage('STAGE 2.15: Saving and sending results');

                        chainResults[chainKey] = addressData;

                        const filePath = `${addressData.average_pnl}${cfg.symbol.toLowerCase()} - ${address}.json`;

                        fs.writeFileSync(filePath, stringifyWithInline({[address]: addressData}, ['pnl', 'transfers', 'trades'], 2));

                        await bot.sendDocument(chatId, filePath, {caption: `\`${address}\``, parse_mode: 'Markdown'});

                        fs.unlinkSync(filePath);

                        // ========== STAGE 2.16: Clear caches ==========
                        logger.logStage('STAGE 2.16: Clearing caches');
                        clearMoralisCache();
                        clearScanCache();
                        clearDexCache();
                        clearCodeCache();
                    } else {
                        logger.logWarning(`Transaction count exceeds limit: ${transactions.length}`);
                        await bot.sendMessage(chatId,
                            `Transactions count address more then ${process.env.SCAN_TRANSACTIONS_COUNT} \n\`${address}\``,
                            {parse_mode: 'MarkdownV2'}
                        );
                    }
                } else {
                    logger.logWarning('Address is a contract, not EOA');
                    await bot.sendMessage(chatId,
                        `Address is contract \n\`${address}\``,
                        {parse_mode: 'MarkdownV2'}
                    );
                }
            }

            // ========== STAGE 3: Multi-chain aggregation ==========
            if (chains.length > 1) {
                logger.logStage('STAGE 3: Multi-chain aggregation');

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

            // ========== END ADDRESS PROCESSING ==========
            logger.endAddress(address);

        } catch (error) {
            console.error(`Error parsing wallet ${address}:`, error);
            logger.logError(`Fatal error: ${error.message}`);
            logger.endAddress(address);
            await bot.sendMessage(chatId,
                `Error parsing wallet \`${address}\`: ${error.message}`,
                {parse_mode: 'Markdown'}
            );
        }
    }
};

module.exports = {walletParserCore};
