const { getWalletTokenSwaps } = require("../../../../api/moralis");

const checkLostSwapsInTransfers = async (config, address, swapsArray, transfersArray) => {
    const swaps = await getWalletTokenSwaps(address, config.chain);

    const swapHashes = new Set(swaps.map(s => s.transactionHash.toLowerCase()));

    const filteredTransfers = transfersArray.filter(
        (tx) => !swapHashes.has(tx.transactionHash.toLowerCase())
    );

    const updatedSwapsArray = [...swapsArray, ...swaps];

    return {
        swaps: updatedSwapsArray,
        transfers: filteredTransfers
    };
};

module.exports = { checkLostSwapsInTransfers };
