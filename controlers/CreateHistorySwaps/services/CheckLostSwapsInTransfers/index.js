const {getTokenTransfers} = require('../../../../api/scan');
const {getWalletTokenSwaps} = require('../../../../api/moralis');

// Concurrency limiter для паралельних запитів
const pLimit = (concurrency) => {
    let active = 0;
    const queue = [];

    const next = () => {
        if (active < concurrency && queue.length > 0) {
            active++;
            const { fn, resolve, reject } = queue.shift();
            fn().then(resolve).catch(reject).finally(() => {
                active--;
                next();
            });
        }
    };

    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
};

const checkLostSwapsInTransfers = async (config, address, swapsArray, transfersArray, nativeTokenPrice) => {
    const rawSwaps = await getWalletTokenSwaps(address, config.chain);

    const grouped = rawSwaps.reduce((acc, swap) => {
        const h = swap.transactionHash.toLowerCase();
        if (!acc[h]) acc[h] = [];
        acc[h].push(swap);
        return acc;
    }, {});

    const swaps = Object.values(grouped).map(group => {
        const tradeSwap = group.find(s =>
            s.bought?.symbol === config.trade_symbol ||
            s.sold?.symbol === config.trade_symbol
        );

        const chosen = tradeSwap || group[0];

        if (tradeSwap) {
            ['bought', 'sold'].forEach(side => {
                if (chosen[side]?.symbol === config.trade_symbol) {
                    chosen[side].symbol = config.symbol;
                }
            });
        }

        ['bought', 'sold'].forEach(side => {
            const token = chosen[side];
            const otherToken = chosen[side];

            const isStable = config.stable_coins.includes(token.address.toLowerCase());
            const isOtherToken = otherToken?.symbol !== config.trade_symbol;

            if (isStable && isOtherToken) {
                token.symbol = config.symbol;

                if (token.amount && nativeTokenPrice) {
                    token.amount = parseFloat(token.amount) / parseFloat(nativeTokenPrice);
                }
            }
        });

        return chosen;
    });

    const existingSwapHashes = new Set(
        swapsArray.map(s => s.transactionHash.toLowerCase())
    );
    const swapHashes = new Set(
        swaps.map(s => s.transactionHash.toLowerCase())
    );

    const filteredTransfers = transfersArray.filter(
        tx => !swapHashes.has(tx.transactionHash.toLowerCase())
    );

    // Фільтруємо свопи, які потребують валідації
    const swapsToValidate = swaps.filter(swap => {
        const hash = swap.transactionHash.toLowerCase();
        if (existingSwapHashes.has(hash)) return false;

        const {bought, sold} = swap;
        const boughtAddress = bought.address.toLowerCase();
        const soldAddress = sold.address.toLowerCase();

        const isBoughtSafe =
            config.contract.includes(boughtAddress) ||
            config.stable_coins.includes(boughtAddress) ||
            config.excluded_contracts.includes(boughtAddress);

        const isSoldSafe =
            config.contract.includes(soldAddress) ||
            config.stable_coins.includes(soldAddress) ||
            config.excluded_contracts.includes(soldAddress);

        // Пропускаємо якщо обидва safe
        if (isBoughtSafe && isSoldSafe) return false;

        // Зберігаємо інформацію для валідації
        swap._validation = { isBoughtSafe, isSoldSafe, boughtAddress, soldAddress };
        return true;
    });

    // Паралельна валідація з обмеженням concurrency (5 паралельних запитів)
    const limit = pLimit(5);

    const validationResults = await Promise.all(
        swapsToValidate.map(swap => limit(async () => {
            const { isBoughtSafe, isSoldSafe, boughtAddress, soldAddress } = swap._validation;
            const block = Number(swap.blockNumber);

            // Перевіряємо bought якщо не safe
            if (!isBoughtSafe) {
                const boughtTransfers = await getTokenTransfers(
                    address,
                    boughtAddress,
                    config.chain_id,
                    block,
                    block
                );
                if (Array.isArray(boughtTransfers) && boughtTransfers.length > 0) {
                    delete swap._validation;
                    return swap;
                }
            }

            // Перевіряємо sold якщо не safe
            if (!isSoldSafe) {
                const soldTransfers = await getTokenTransfers(
                    address,
                    soldAddress,
                    config.chain_id,
                    block,
                    block
                );
                if (Array.isArray(soldTransfers) && soldTransfers.length > 0) {
                    delete swap._validation;
                    return swap;
                }
            }

            return null;
        }))
    );

    const validatedSwaps = validationResults.filter(Boolean);
    const updatedSwapsArray = [...swapsArray, ...validatedSwaps];

    return {
        swaps: updatedSwapsArray,
        transfers: filteredTransfers
    };
};

module.exports = {checkLostSwapsInTransfers};
