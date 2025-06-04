const {getTokenPrice} = require('../api/moralis');

const checkTransactionHistory = async (config, address, transactions, nativeTokenPrice) => {
    const swapsArray = [];
    const transfersArray = [];
    const virtualContract = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b'.toLowerCase();

    for (const tx of transactions) {
        if (tx.category === 'token swap') {
            const {erc20_transfers = [], native_transfers = []} = tx;

            const fromTransfers = erc20_transfers.filter(t => t.from_address.toLowerCase() === address.toLowerCase());
            const toTransfers = erc20_transfers.filter(t => t.to_address.toLowerCase() === address.toLowerCase());

            const nativeSend = native_transfers.find(n => n.from_address.toLowerCase() === address.toLowerCase() && n.direction === 'send');
            const nativeReceive = native_transfers.find(n => n.to_address.toLowerCase() === address.toLowerCase() && n.direction === 'receive');

            if (!fromTransfers.length && toTransfers.length && nativeSend && toTransfers[0].address.toLowerCase() !== virtualContract) {
                const symbolOut = toTransfers[0].token_symbol;
                const contractOut = toTransfers[0].address;
                const amountOutRaw = toTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountInRaw = parseFloat(nativeSend.value_formatted || '0');

                let transactionType = 'buy';

                if (config.stable_coins.includes(contractOut)) {
                    transactionType = 'sell';
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

            if (fromTransfers.length && !toTransfers.length && nativeReceive && fromTransfers[0].address.toLowerCase() !== virtualContract) {
                const symbolIn = fromTransfers[0].token_symbol;
                const contractIn = fromTransfers[0].address;

                const amountInRaw = fromTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountOutRaw = parseFloat(nativeReceive.value_formatted || '0');

                let transactionType = 'sell';

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

            if (
                fromTransfers.length &&
                toTransfers.length &&
                ![...config.stable_coins, config.contract, virtualContract].includes(fromTransfers[0].address.toLowerCase()) &&
                ![...config.stable_coins, config.contract, virtualContract].includes(toTransfers[0].address.toLowerCase())
            ) {
                const symbolIn = fromTransfers[0].token_symbol;
                const symbolOut = toTransfers[0].token_symbol;
                const amountIn = fromTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountOut = toTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);

                const priceIn = await getTokenPrice(fromTransfers[0].address, config.chain, tx.block_number);
                const priceOut = await getTokenPrice(toTransfers[0].address, config.chain, tx.block_number);

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
                        amount: priceOut?.usdPrice ? -((amountOut * priceOut?.usdPrice || 0) / nativeTokenPrice) : -((amountIn * priceIn?.usdPrice || 0) / nativeTokenPrice),
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
                        amount: priceIn?.usdPrice ? ((amountIn * priceIn?.usdPrice || 0) / nativeTokenPrice) : ((amountOut * priceOut?.usdPrice || 0) / nativeTokenPrice),
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

            const symbolIn = fromTransfers[0].token_symbol;
            const contractIn = fromTransfers[0].address;
            const symbolOut = toTransfers[0].token_symbol;
            const contractOut = toTransfers[0].address;

            const amountIn = fromTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
            const amountOut = toTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);

            let transactionType;
            let sold, bought;

            if (contractIn.toLowerCase() === config.contract.toLowerCase()) {
                transactionType = 'buy';
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
                const virtualPrice = await getTokenPrice(contractOut, config.chain, tx.block_number);

                transactionType = 'sell';
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    symbol: config.trade_symbol,
                    amount: (amountOut * virtualPrice?.usdPrice || 0) / nativeTokenPrice,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (contractIn.toLowerCase() === virtualContract && config.chain === 'base') {
                const virtualPrice = await getTokenPrice(contractIn, config.chain, tx.block_number);

                transactionType = 'buy';
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    symbol: config.trade_symbol,
                    amount: -((amountIn * virtualPrice?.usdPrice || 0) / nativeTokenPrice),
                    pairAddress: toTransfers[0].from_address
                };
            } else if (contractOut.toLowerCase() === config.contract.toLowerCase()) {
                transactionType = 'sell';
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
            } else if (contractIn.toLowerCase() === config.contract.toLowerCase()) {
                transactionType = 'buy';
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
            } else {
                continue;
            }


            swapsArray.push({
                transactionType,
                blockTimestamp: tx.block_timestamp,
                transactionHash: tx.hash,
                from: tx.from_address,
                to: tx.to_address,
                summary: tx.summary,
                category: tx.category,
                bought,
                sold
            });
        } else if (tx.category === 'send' || tx.category === 'receive' || tx.category === 'token send' || tx.category === 'token receive') {
            const transfer = tx.erc20_transfers[0];
            transfersArray.push({
                transactionHash: tx.hash,
                tokenSymbol: transfer?.token_symbol,
                blockTimestamp: tx.block_timestamp,
                value: tx.value,
                contract: transfer?.address,
                summary: tx.summary,
                category: tx.category,
                from: tx.from_address,
                to: tx.to_address,
            });
        }
    }

    return {
        swaps: swapsArray,
        transfers: transfersArray,
    };
};

module.exports = {checkTransactionHistory};
