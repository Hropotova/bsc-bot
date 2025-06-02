const {getTokenPrice} = require('../api/moralis');

const checkTransactionHistory = async (address, transactions, symbol, tradeSymbol, nativeTokenPrice, chain) => {
    const swapsArray = [];


    const transfersArray = [];

    for (const tx of transactions) {
        if (tx.category === 'token swap') {
            const {erc20_transfers = [], native_transfers = []} = tx;

            const fromTransfers = erc20_transfers.filter(t => t.from_address.toLowerCase() === address.toLowerCase());
            const toTransfers = erc20_transfers.filter(t => t.to_address.toLowerCase() === address.toLowerCase());

            const nativeSend = native_transfers.find(n => n.from_address.toLowerCase() === address.toLowerCase() && n.direction === 'send');
            const nativeReceive = native_transfers.find(n => n.to_address.toLowerCase() === address.toLowerCase() && n.direction === 'receive');

            if (!fromTransfers.length && toTransfers.length && nativeSend && toTransfers[0].token_symbol !== 'VIRTUAL') {
                const symbolOut = toTransfers[0].token_symbol;
                const amountOutRaw = toTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountInRaw = parseFloat(nativeSend.value_formatted || '0');

                let transactionType = 'buy';
                let soldSymbol = symbol;

                if (symbolOut === 'USDT') {
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
                            symbol: tradeSymbol,
                            amount: amountOutRaw / nativeTokenPrice,
                            address: toTransfers[0].address,
                            pairAddress: toTransfers[0].from_address
                        },
                        sold: {
                            symbol: soldSymbol,
                            amount: -amountInRaw,
                            pairAddress: toTransfers[0].from_address
                        }
                    });
                    continue;
                }

                if (symbolOut === tradeSymbol) transactionType = 'sell';

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
                        symbol: soldSymbol,
                        amount: -amountInRaw,
                        pairAddress: toTransfers[0].from_address
                    }
                });
                continue;
            }

            if (fromTransfers.length && !toTransfers.length && nativeReceive && fromTransfers[0].token_symbol !== 'VIRTUAL') {
                const symbolIn = fromTransfers[0].token_symbol;
                const amountInRaw = fromTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountOutRaw = parseFloat(nativeReceive.value_formatted || '0');

                let transactionType = 'sell';

                if (symbolIn === 'USDT') {
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
                            symbol: tradeSymbol,
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

                if (symbolIn === tradeSymbol) {
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
                        symbol: tradeSymbol,
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
                ![symbol, tradeSymbol, 'USDT', 'VIRTUAL'].includes(fromTransfers[0].token_symbol) &&
                ![symbol, tradeSymbol, 'USDT', 'VIRTUAL'].includes(toTransfers[0].token_symbol)
            ) {
                console.log(tx.hash)
                console.log(tx)
                const symbolIn = fromTransfers[0].token_symbol;
                const symbolOut = toTransfers[0].token_symbol;
                const amountIn = fromTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
                const amountOut = toTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);

                const priceIn = await getTokenPrice(fromTransfers[0].address, chain, tx.block_number);
                const priceOut = await getTokenPrice(toTransfers[0].address, chain, tx.block_number);

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
                        symbol: tradeSymbol,
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
                        symbol: tradeSymbol,
                        amount: priceIn?.usdPrice ? ((amountIn * priceIn?.usdPrice || 0) / nativeTokenPrice) : ((amountOut * priceOut?.usdPrice || 0) / nativeTokenPrice),
                        pairAddress: fromTransfers[0].to_address
                    },
                    sold: {
                        symbol: symbolIn,
                        amount: amountIn,
                        address: toTransfers[0].address,
                        pairAddress: fromTransfers[0].to_address
                    }
                });
                continue;
            }

            if (!fromTransfers.length || !toTransfers.length) continue;

            const symbolIn = fromTransfers[0].token_symbol;
            const symbolOut = toTransfers[0].token_symbol;

            const amountIn = fromTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);
            const amountOut = toTransfers.reduce((sum, t) => sum + parseFloat(t.value_formatted || '0'), 0);

            let transactionType;
            let sold, bought;

            if (symbolIn === symbol) {
                transactionType = 'buy';
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    symbol: tradeSymbol,
                    amount: -amountIn,
                    pairAddress: toTransfers[0].from_address
                };
            } else if (symbolOut === symbol) {
                transactionType = 'sell';
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    symbol: tradeSymbol,
                    amount: amountOut,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (symbolOut === 'USDT') {
                transactionType = 'sell';
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    symbol: tradeSymbol,
                    amount: amountOut / nativeTokenPrice,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (symbolIn === 'USDT') {
                transactionType = 'buy';
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    symbol: tradeSymbol,
                    amount: -(amountIn / nativeTokenPrice),
                    pairAddress: toTransfers[0].from_address
                };
            } else if (symbolOut === 'VIRTUAL' && chain === 'base') {
                const virtualPrice = await getTokenPrice('0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', chain, tx.block_number);

                transactionType = 'sell';
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    symbol: tradeSymbol,
                    amount: (amountOut * virtualPrice?.usdPrice || 0) / nativeTokenPrice,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (symbolIn === 'VIRTUAL' && chain === 'base') {
                const virtualPrice = await getTokenPrice('0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', chain, tx.block_number);

                transactionType = 'buy';
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    symbol: tradeSymbol,
                    amount: -((amountIn * virtualPrice?.usdPrice || 0) / nativeTokenPrice),
                    pairAddress: toTransfers[0].from_address
                };
            } else if (symbolOut === tradeSymbol) {
                transactionType = 'sell';
                sold = {
                    symbol: symbolIn,
                    amount: amountIn,
                    address: fromTransfers[0].address,
                    pairAddress: fromTransfers[0].to_address
                };
                bought = {
                    symbol: tradeSymbol,
                    amount: amountOut,
                    pairAddress: fromTransfers[0].to_address
                };
            } else if (symbolIn === tradeSymbol) {
                transactionType = 'buy';
                bought = {
                    symbol: symbolOut,
                    amount: amountOut,
                    address: toTransfers[0].address,
                    pairAddress: toTransfers[0].from_address
                };
                sold = {
                    symbol: tradeSymbol,
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
    // console.log('swapsArray', swapsArray)
    return {
        swaps: swapsArray,
        transfers: transfersArray,
    };
};

module.exports = {checkTransactionHistory};
