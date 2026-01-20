const {getTokenPrice, getTokenPricesBatch} = require('../../api/moralis');
const {checkLostSwapsInTransfers} = require('./services');

const createHistorySwaps = async (config, address, transactions, nativeTokenPrice) => {
    const swapsArray = [];
    const transfersArray = [];
    const virtualContract = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b'.toLowerCase();
    const TX_CATEGORIES = ['send', 'receive', 'token send', 'token receive', 'contract interaction'];

    // ============================================================
    // PHASE 1: Збираємо ВСІ потрібні (token, block) пари
    // ============================================================
    const priceRequests = new Map(); // key: `${token}:${block}` -> { token, block }

    for (const tx of transactions) {
        if (tx.category !== 'token swap') continue;

        const {erc20_transfers = [], native_transfers = []} = tx;
        const fromTransfers = erc20_transfers.filter(t => t.from_address.toLowerCase() === address.toLowerCase());
        const toTransfers = erc20_transfers.filter(t => t.to_address.toLowerCase() === address.toLowerCase());

        if (!fromTransfers.length || !toTransfers.length) continue;

        const contractIn = fromTransfers[0]?.address?.toLowerCase();
        const contractOut = toTransfers[0]?.address?.toLowerCase();
        const blockNumber = tx.block_number;

        if (!blockNumber) continue;

        // Визначаємо чи це typeSwap 3, 8, або 9
        const nativeSend = native_transfers.find(n => n.from_address.toLowerCase() === address.toLowerCase() && n.direction === 'send');
        const nativeReceive = native_transfers.find(n => n.to_address.toLowerCase() === address.toLowerCase() && n.direction === 'receive');

        const isTypeSwap3 = fromTransfers.length && toTransfers.length &&
            ![...config.stable_coins, config.contract, virtualContract].includes(contractIn) &&
            ![...config.stable_coins, config.contract, virtualContract].includes(contractOut);

        const isTypeSwap8 = contractOut === virtualContract && config.chain === 'base';
        const isTypeSwap9 = contractIn === virtualContract && config.chain === 'base';

        if (isTypeSwap3 && contractIn && contractOut) {
            priceRequests.set(`${contractIn}:${blockNumber}`, { token: contractIn, block: blockNumber });
            priceRequests.set(`${contractOut}:${blockNumber}`, { token: contractOut, block: blockNumber });
        } else if (isTypeSwap8 || isTypeSwap9) {
            priceRequests.set(`${virtualContract}:${blockNumber}`, { token: virtualContract, block: blockNumber });
        }
    }

    // ============================================================
    // PHASE 2: Групуємо по блоках і робимо ПАРАЛЕЛЬНІ запити
    // ============================================================
    if (priceRequests.size > 0) {
        const byBlock = new Map(); // block -> [tokens]
        for (const { token, block } of priceRequests.values()) {
            if (!byBlock.has(block)) byBlock.set(block, new Set());
            byBlock.get(block).add(token);
        }

        // Паралельно запитуємо ціни (до 5 блоків одночасно)
        const PARALLEL_LIMIT = 5;
        const blockEntries = [...byBlock.entries()];

        for (let i = 0; i < blockEntries.length; i += PARALLEL_LIMIT) {
            const chunk = blockEntries.slice(i, i + PARALLEL_LIMIT);
            await Promise.all(
                chunk.map(([block, tokens]) =>
                    getTokenPricesBatch([...tokens], config.chain, Number(block))
                )
            );
        }
    }

    // ============================================================
    // PHASE 3: Основний цикл (ціни вже в кеші!)
    // ============================================================
    for (const tx of transactions) {
        if (tx.category === 'token swap') {
            const {erc20_transfers = [], native_transfers = []} = tx;

            const fromTransfers = erc20_transfers.filter(
                t => t.from_address.toLowerCase() === address.toLowerCase()
            );
            const toTransfers = erc20_transfers.filter(
                t => t.to_address.toLowerCase() === address.toLowerCase()
            );

            let symbolOut, contractOut;
            let symbolIn, contractIn;
            if (toTransfers.length) {
                symbolOut = toTransfers[0].token_symbol;
                contractOut = toTransfers[0].address;
            }
            if (fromTransfers.length) {
                symbolIn = fromTransfers[0].token_symbol;
                contractIn = fromTransfers[0].address;
            }

            const nativeSend = native_transfers.find(
                n => n.from_address.toLowerCase() === address.toLowerCase() && n.direction === 'send'
            );
            const nativeReceive = native_transfers.find(
                n => n.to_address.toLowerCase() === address.toLowerCase() && n.direction === 'receive'
            );

            let typeSwap;

            // typeSwap 1: native -> stablecoin
            if (!fromTransfers.length && toTransfers.length && nativeSend && toTransfers[0].address.toLowerCase() !== virtualContract) {
                const amountOutRaw = toTransfers
                    .filter(t => t.address.toLowerCase() === contractOut)
                    .reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountInRaw = parseFloat(nativeSend.value_formatted || '0');

                let transactionType = 'buy';

                if (config.stable_coins.includes(contractOut)) {
                    transactionType = 'sell';
                    typeSwap = 1;
                    swapsArray.push({
                        transactionType,
                        blockTimestamp: tx.block_timestamp,
                        transactionHash: tx.hash,
                        from: tx.from_address,
                        to: tx.to_address,
                        summary: tx.summary,
                        category: tx.category,
                        bought: {
                            symbol: config.trade_symbol,
                            amount: amountOutRaw / nativeTokenPrice,
                            address: toTransfers[0].address,
                            pairAddress: toTransfers[0].from_address
                        },
                        sold: {
                            symbol: config.symbol,
                            amount: -amountInRaw,
                            pairAddress: toTransfers[0].from_address
                        }
                    });
                    continue;
                }

                if (contractOut.toLowerCase() === config.contract.toLowerCase()) transactionType = 'sell';

                swapsArray.push({
                    transactionType,
                    blockTimestamp: tx.block_timestamp,
                    transactionHash: tx.hash,
                    from: tx.from_address,
                    to: tx.to_address,
                    summary: tx.summary,
                    category: tx.category,
                    bought: {
                        symbol: symbolOut,
                        amount: amountOutRaw,
                        address: toTransfers[0].address,
                        pairAddress: toTransfers[0].from_address
                    },
                    sold: {
                        symbol: config.symbol,
                        amount: -amountInRaw,
                        pairAddress: toTransfers[0].from_address
                    }
                });
                continue;
            }

            // typeSwap 2: token -> native
            if (fromTransfers.length && !toTransfers.length && nativeReceive && fromTransfers[0].address.toLowerCase() !== virtualContract) {
                const amountInRaw = fromTransfers
                    .filter(t => t.address.toLowerCase() === contractIn)
                    .reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountOutRaw = parseFloat(nativeReceive.value_formatted || '0');

                let transactionType = 'sell';
                typeSwap = 2;

                if (config.stable_coins.includes(contractIn)) {
                    transactionType = 'buy';
                    swapsArray.push({
                        transactionType,
                        blockTimestamp: tx.block_timestamp,
                        transactionHash: tx.hash,
                        from: tx.from_address,
                        to: tx.to_address,
                        summary: tx.summary,
                        category: tx.category,
                        bought: {
                            symbol: config.trade_symbol,
                            amount: amountOutRaw / nativeTokenPrice,
                            address: nativeReceive.to_address,
                            pairAddress: fromTransfers[0].to_address
                        },
                        sold: {
                            symbol: symbolIn,
                            amount: amountInRaw,
                            address: fromTransfers[0].address,
                            pairAddress: fromTransfers[0].to_address
                        }
                    });
                    continue;
                }

                if (contractIn.toLowerCase() === config.contract.toLowerCase()) {
                    transactionType = 'buy';
                }

                swapsArray.push({
                    transactionType,
                    blockTimestamp: tx.block_timestamp,
                    transactionHash: tx.hash,
                    from: tx.from_address,
                    to: tx.to_address,
                    summary: tx.summary,
                    category: tx.category,
                    bought: {
                        symbol: config.trade_symbol,
                        amount: amountOutRaw,
                        address: nativeReceive.to_address,
                        pairAddress: fromTransfers[0].to_address
                    },
                    sold: {
                        symbol: symbolIn,
                        amount: amountInRaw,
                        address: fromTransfers[0].address,
                        pairAddress: fromTransfers[0].to_address
                    }
                });
                continue;
            }

            // typeSwap 3: token <-> token (обидва НЕ native/stable/virtual)
            if (
                fromTransfers.length &&
                toTransfers.length &&
                ![...config.stable_coins, config.contract, virtualContract].includes(fromTransfers[0].address.toLowerCase()) &&
                ![...config.stable_coins, config.contract, virtualContract].includes(toTransfers[0].address.toLowerCase())
            ) {
                typeSwap = 3;

                const amountIn = fromTransfers
                    .filter(t => t.address.toLowerCase() === contractIn)
                    .reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountOut = toTransfers
                    .filter(t => t.address.toLowerCase() === contractOut)
                    .reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);

                const blockNumber = tx.block_number;
                const addrIn = fromTransfers[0].address?.toLowerCase();
                const addrOut = toTransfers[0].address?.toLowerCase();

                // Ціни вже в кеші після PHASE 2!
                const batch = await getTokenPricesBatch([addrIn, addrOut], config.chain, Number(blockNumber));
                const priceIn = batch.get(addrIn) ?? null;
                const priceOut = batch.get(addrOut) ?? null;

                swapsArray.push({
                    transactionType: 'buy',
                    blockTimestamp: tx.block_timestamp,
                    transactionHash: tx.hash,
                    from: tx.from_address,
                    to: tx.to_address,
                    summary: tx.summary,
                    category: tx.category,
                    bought: {
                        symbol: symbolOut,
                        amount: amountOut,
                        address: toTransfers[0].address,
                        pairAddress: toTransfers[0].from_address
                    },
                    sold: {
                        symbol: config.trade_symbol,
                        amount: priceOut?.usdPrice
                            ? -((amountOut * priceOut?.usdPrice || 0) / nativeTokenPrice)
                            : -((amountIn * priceIn?.usdPrice || 0) / nativeTokenPrice),
                        pairAddress: toTransfers[0].from_address
                    }
                });

                swapsArray.push({
                    transactionType: 'sell',
                    blockTimestamp: tx.block_timestamp,
                    transactionHash: tx.hash,
                    from: tx.from_address,
                    to: tx.to_address,
                    summary: tx.summary,
                    category: tx.category,
                    bought: {
                        symbol: config.trade_symbol,
                        amount: priceIn?.usdPrice
                            ? ((amountIn * priceIn?.usdPrice || 0) / nativeTokenPrice)
                            : ((amountOut * priceOut?.usdPrice || 0) / nativeTokenPrice),
                        pairAddress: fromTransfers[0].to_address
                    },
                    sold: {
                        symbol: symbolIn,
                        amount: amountIn,
                        address: fromTransfers[0].address,
                        pairAddress: fromTransfers[0].to_address
                    }
                });
                continue;
            }

            if (!fromTransfers.length || !toTransfers.length) continue;

            const amountIn = fromTransfers
                .filter(t => t.address.toLowerCase() === contractIn)
                .reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
            const amountOut = toTransfers
                .filter(t => t.address.toLowerCase() === contractOut)
                .reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);

            let transactionType;
            let sold, bought;

            if (contractIn.toLowerCase() === config.contract.toLowerCase()) {
                transactionType = 'buy';
                typeSwap = 4;
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    symbol: config.trade_symbol,
                    amount: -amountIn,
                    pairAddress: toTransfers[0].from_address
                };
            } else if (contractOut.toLowerCase() === config.contract.toLowerCase()) {
                transactionType = 'sell';
                typeSwap = 5;
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    symbol: config.trade_symbol,
                    amount: amountOut,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (config.stable_coins.includes(contractOut)) {
                transactionType = 'sell';
                typeSwap = 6;
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    symbol: config.trade_symbol,
                    amount: amountOut / nativeTokenPrice,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (config.stable_coins.includes(contractIn)) {
                transactionType = 'buy';
                typeSwap = 7;
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    symbol: config.trade_symbol,
                    amount: -(amountIn / nativeTokenPrice),
                    pairAddress: toTransfers[0].from_address
                };
            } else if (contractOut.toLowerCase() === virtualContract && config.chain === 'base') {
                // Ціна вже в кеші!
                const blockNumber = tx.block_number;
                const batch = await getTokenPricesBatch([virtualContract], config.chain, Number(blockNumber));
                const virtualPrice = batch.get(virtualContract) ?? null;

                transactionType = 'sell';
                typeSwap = 8;
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    isVirtual: true,
                    symbol: config.trade_symbol,
                    amount: (amountOut * virtualPrice?.usdPrice || 0) / nativeTokenPrice,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (contractIn.toLowerCase() === virtualContract && config.chain === 'base') {
                // Ціна вже в кеші!
                const blockNumber = tx.block_number;
                const batch = await getTokenPricesBatch([virtualContract], config.chain, Number(blockNumber));
                const virtualPrice = batch.get(virtualContract) ?? null;

                transactionType = 'buy';
                typeSwap = 9;
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    isVirtual: true,
                    symbol: config.trade_symbol,
                    amount: -((amountIn * virtualPrice?.usdPrice || 0) / nativeTokenPrice),
                    pairAddress: toTransfers[0].from_address
                };
            } else {
                continue;
            }

            swapsArray.push({
                transactionType,
                typeSwap,
                blockTimestamp: tx?.block_timestamp,
                transactionHash: tx?.hash,
                from: tx?.from_address,
                to: tx?.to_address,
                summary: tx?.summary,
                category: tx?.category,
                bought,
                sold
            });
        } else if (TX_CATEGORIES.includes(tx.category)) {
            const transfer = tx.erc20_transfers[0];
            const from = tx.erc20_transfers.length > 0 ? tx.erc20_transfers[0].from_address : tx.from_address;
            const to = tx.erc20_transfers.length > 0 ? tx.erc20_transfers[0].to_address : tx.to_address;

            if (
                (from?.toLowerCase() === address?.toLowerCase() || to?.toLowerCase() === address?.toLowerCase()) &&
                Number(tx?.erc20_transfers[0]?.value_formatted) > 0
            ) {
                transfersArray.push({
                    transactionHash: tx?.hash,
                    tokenSymbol: transfer?.token_symbol,
                    blockTimestamp: tx.block_timestamp,
                    value: tx?.erc20_transfers[0]?.value_formatted,
                    contract: transfer?.address,
                    summary: tx?.summary,
                    category: tx?.category === 'contract interaction'
                        ? (from?.toLowerCase() === address?.toLowerCase() ? 'send' : 'receive')
                        : tx?.category,
                    from,
                    to,
                });
            }
        }
    }

    const {swaps, transfers} = await checkLostSwapsInTransfers(config, address, swapsArray, transfersArray, nativeTokenPrice);
    return {swaps, transfers};
};

module.exports = {createHistorySwaps};
