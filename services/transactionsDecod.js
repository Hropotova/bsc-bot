require('dotenv').config();
const Web3 = require('web3');
const Bottleneck = require('bottleneck');

const {getContractAddressTransactions, getInternalTransactions} = require('../api/scan');
const {getTokenPrice} = require('../api/crypto');

const web3 = new Web3(process.env.PROVIDER);

const limiter = new Bottleneck({
    minTime: 200,
    maxConcurrent: 1
});

const transactionsDecod = async (contract, address) => {
    console.log('\nCONTRACT —', contract)

    const contractAddressTransactions = await getContractAddressTransactions(address, contract);
    let sentTokens = [];
    let receivedTokens = [];
    let shouldSkipContract = false;

    const tokenSymbolCache = new Map();
    const transferLogs = [];

    const ERC20_ABI = [
        {
            "constant": true,
            "inputs": [],
            "name": "symbol",
            "outputs": [{"name": "", "type": "string"}],
            "type": "function"
        },
        {
            "constant": true,
            "inputs": [{"name": "_owner", "type": "address"}],
            "name": "balanceOf",
            "outputs": [{"name": "balance", "type": "uint256"}],
            "type": "function"
        }
    ];

    const getTokenSymbol = async (contractAddress) => {
        try {
            if (tokenSymbolCache.has(contractAddress)) {
                return tokenSymbolCache.get(contractAddress);
            }

            const contract = new web3.eth.Contract(ERC20_ABI, contractAddress);
            const symbol = await contract.methods.symbol().call();
            tokenSymbolCache.set(contractAddress, symbol);
            return symbol;
        } catch (error) {
            console.error(`Error get token symbol ${contractAddress}:`, error);
            return "Unknown";
        }
    };

    const getTokenBalance = async (contractAddress) => {
        try {
            if (!contractAddress) {
                throw new Error('Contract address and wallet address are required');
            }

            const contract = new web3.eth.Contract(ERC20_ABI, contractAddress);

            const balance = await contract.methods.balanceOf(address).call();

            const balanceInEther = web3.utils.fromWei(balance, 'ether');
            return parseFloat(balanceInEther);
        } catch (error) {
            console.error(`Error get token balance ${contractAddress}:`, error.message);
            return 0;
        }
    };

    const trackTransfer = (decoded, log, walletAddress, transfer, hash) => {
        const tokenSymbol = tokenSymbolCache.get(log.address) || "Unknown";
        const value = parseFloat(web3.utils.fromWei(decoded.value, 'ether'));

        const isIncoming = decoded.to.toUpperCase() === walletAddress.toUpperCase();
        const isOutgoing = decoded.from.toUpperCase() === walletAddress.toUpperCase();

        if (isIncoming) {
            receivedTokens.push({token: tokenSymbol, value, transfer, hash});
        } else if (isOutgoing) {
            sentTokens.push({token: tokenSymbol, value, transfer, hash});
        }
    };

    for (const transaction of contractAddressTransactions) {
        await limiter.schedule(async () => {
            try {
                const transactionCheck = await web3.eth.getTransaction(transaction.hash);

                const checkFrom = transactionCheck.from.toUpperCase() === address.toUpperCase();
                const methodId = transactionCheck.input.slice(0, 10);
                const checkTransfer = (methodId === '0xa9059cbb');

                if (!checkTransfer && !checkFrom) {
                    shouldSkipContract = true;
                    sentTokens = [];
                    receivedTokens = [];
                    tokenSymbolCache.clear();
                    transferLogs.length = 0;
                    return false;
                }

                if (shouldSkipContract) {
                    return false;
                }

                const transfers = await getInternalTransactions(transaction.hash);
                console.log('transfers', transfers)
                const receipt = await web3.eth.getTransactionReceipt(transaction.hash);

                const currentTransferLogs = [];

                for (const log of receipt.logs) {
                    const eventSignature = log.topics[0];

                    if (eventSignature === web3.utils.keccak256("Transfer(address,address,uint256)")) {
                        const decoded = web3.eth.abi.decodeLog(
                            [
                                {type: 'address', name: 'from', indexed: true},
                                {type: 'address', name: 'to', indexed: true},
                                {type: 'uint256', name: 'value'}
                            ],
                            log.data,
                            log.topics.slice(1)
                        );

                        const tokenSymbol = await getTokenSymbol(log.address);

                        let transfer;
                        if (checkTransfer) {
                            if (receipt.from.toUpperCase() === address.toUpperCase()) {
                                transfer = 'out';
                            } else if (receipt.to.toUpperCase() === address.toUpperCase()) {
                                transfer = 'in';
                            }
                        } else {
                            transfer = false;
                        }

                        currentTransferLogs.push({
                            from: decoded.from,
                            to: decoded.to,
                            value: web3.utils.fromWei(decoded.value, 'ether'),
                            token: tokenSymbol,
                            contract: log.address,
                        });

                        trackTransfer(decoded, log, address, transfer, transaction.hash);
                    }
                }

                console.log('currentTransferLogs', currentTransferLogs)

                if (transfers.length > 0) {
                    if (currentTransferLogs.some(i => i.from.toUpperCase() === address.toUpperCase())) {
                        const transactions = transfers.filter(i => i.to.toUpperCase() === receipt.from.toUpperCase());
                        const totalEther = transactions.reduce((sum, tx) => {
                            const valueInEther = parseFloat(tx.value) / 10 ** 18;
                            return sum + valueInEther;
                        }, 0);
                        if (totalEther > 0) {
                            receivedTokens.push({token: 'WBNB', value: totalEther});
                        }
                    } else if (currentTransferLogs.some(i => i.to.toUpperCase() === address.toUpperCase())) {
                        const transactions = transfers.filter(i => i.from.toUpperCase() === receipt.to.toUpperCase());
                        const totalEther = transactions.reduce((sum, tx) => {
                            const valueInEther = parseFloat(tx.value) / 10 ** 18;
                            return sum + valueInEther;
                        }, 0);
                        if (totalEther > 0) {
                            sentTokens.push({token: 'WBNB', value: totalEther});
                        }
                    }
                }
            } catch (error) {
                console.error(`Error parse transaction: ${transaction.hash}`, error);
            }
        });

        if (shouldSkipContract) {
            break;
        }
    }

    if (shouldSkipContract || (sentTokens.length === 0 && receivedTokens.length === 0)) {
        return {};
    }

    const balance = await getTokenBalance(contract);
    const price = await getTokenPrice(contract);
    const symbol = await getTokenSymbol(contract);

    const outTransfer = sentTokens.some(i => i.transfer === 'out');
    const inTransfer = receivedTokens.some(i => i.transfer === 'in');

    let transfer = false;

    if (outTransfer && inTransfer) {
        transfer = 'in'
    } else if (inTransfer) {
        transfer = 'in'
    } else if (outTransfer) {
        transfer = 'out'
    }

    console.log("\nSPENT TOKENS:", sentTokens);
    console.log("\nRECEIVED TOKENS:", receivedTokens);

    return {
        symbol,
        contract,
        price,
        balance,
        transfer,
        totalSent: sentTokens.length > 0 ? sentTokens : null,
        totalReceive: receivedTokens.length > 0 ? receivedTokens : null
    };
};

module.exports = {transactionsDecod};
