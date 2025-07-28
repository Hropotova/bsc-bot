const {getTokenTransfers} = require('../../../../api/scan');
const {getWalletTokenSwaps} = require('../../../../api/moralis');

const checkLostSwapsInTransfers = async (config, address, swapsArray, transfersArray) => {
    const swaps = await getWalletTokenSwaps(address, config.chain);

    const existingSwapHashes = new Set(swapsArray.map(s => s.transactionHash.toLowerCase()));
    const swapHashes = new Set(swaps.map(s => s.transactionHash.toLowerCase()));

    const filteredTransfers = transfersArray.filter(
        tx => !swapHashes.has(tx.transactionHash.toLowerCase())
    );

    const validatedSwaps = [];

    for (const swap of swaps) {
        const hash = swap.transactionHash.toLowerCase();
        if (existingSwapHashes.has(hash)) continue;

        const { bought, sold } = swap;

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

        if (isBoughtSafe && isSoldSafe) continue;

        let shouldAdd = false;

        if (!isBoughtSafe) {
            const boughtTransfers = await getTokenTransfers(address, boughtAddress, config.chain_id);
            if (Array.isArray(boughtTransfers) && boughtTransfers.length > 0) {
                shouldAdd = true;
            }
        }

        if (!shouldAdd && !isSoldSafe) {
            const soldTransfers = await getTokenTransfers(address, soldAddress, config.chain_id);
            if (Array.isArray(soldTransfers) && soldTransfers.length > 0) {
                shouldAdd = true;
            }
        }

        if (shouldAdd) {
            validatedSwaps.push(swap);
        }
    }

    const updatedSwapsArray = [...swapsArray, ...validatedSwaps];

    return {
        swaps: updatedSwapsArray,
        transfers: filteredTransfers
    };
};

module.exports = {checkLostSwapsInTransfers};
