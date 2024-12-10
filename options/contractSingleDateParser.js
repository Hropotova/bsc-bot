const Web3 = require('web3');
const fs = require('fs');
const ExcelJS = require('exceljs');

const {
    getAddressListTransaction,
    getContractAddressTransactions,
    getAddressTransactionsSorted,
} = require('../api/scan');
const {getEthereumPrice, getWalletBalance, getTokenPrice} = require('../api/crypto');

const {ERC20_ABI} = require('../constants/erc2_abi');

const web3 = new Web3(process.env.PROVIDER);

class RateLimiter {
    constructor(rateLimit) {
        this.rateLimit = rateLimit;
        this.tokens = rateLimit;
        this.lastRefill = Date.now();
        this.refillRate = 2000; // 2000 milliseconds = 2 seconds
    }

    async wait() {
        const now = Date.now();
        const elapsedTime = now - this.lastRefill;
        const tokensToAdd = Math.floor(elapsedTime / this.refillRate);
        this.tokens = Math.min(this.rateLimit, this.tokens + tokensToAdd);
        this.lastRefill = now - (elapsedTime % this.refillRate);

        if (this.tokens === 0) {
            const delay = this.lastRefill + this.refillRate - now;
            await new Promise(resolve => setTimeout(resolve, delay));
            this.tokens = this.rateLimit;
            this.lastRefill = Date.now();
        }

        this.tokens--;
    }
}

const rateLimiter = new RateLimiter(5);

const contractSingleDateParser = async (address, bot, chatId, addressState) => {

    const addressTokenTransactions = await getAddressTransactionsSorted(addressState);
    const date = new Date(address);
    const unixTime = Math.floor(date.getTime() / 1000);
    const filteredTransactions = addressTokenTransactions.filter(tx => parseInt(tx.timeStamp, 10) < unixTime);
    const buyers = new Set();

    await Promise.all(filteredTransactions.map(async (tx) => {
        const isAddress = await web3.eth.getCode(tx.to);
        if (isAddress === '0x') {
            buyers.add(tx.to);
        }
    }))

    const ethereumPrice = await getEthereumPrice();

    let results = [];
    let contactSymbol;

    console.log(Array.from(buyers).length);
    for (let i = 0; i < Array.from(buyers).length; i += 5) {
        console.log(i)
        const chunk = Array.from(buyers).slice(i, i + 5);
        console.log('chunk', chunk)
        await Promise.all(chunk.map(async wallet => {
            await rateLimiter.wait();
            try {
                const walletBalance = await getWalletBalance(contract);

                const tokenContract = new web3.eth.Contract(ERC20_ABI, addressState);
                const symbol = await tokenContract.methods.symbol().call();
                const decimals = await tokenContract.methods.decimals().call();
                const contracttokenBalance = await tokenContract.methods.balanceOf(contract).call();
                const balanceInToken = contracttokenBalance / Math.pow(10, decimals);

                const balance = walletBalance.find(i => i.address.toLowerCase() === addressState.toLowerCase()) || 0;

                contactSymbol = symbol;

                const ethResults = [];
                let totalSpent = 0;
                let totalReceived = 0;

                const addressListTransactions = await getAddressListTransaction(contract);

                const contractAddressTransactions = await getContractAddressTransactions(contract, addressState);

                const uniqueData = Array.from(
                    contractAddressTransactions.reduce((map, obj) => map.set(obj.hash, obj), new Map()).values()
                );

                const buyersTxTr = new Set();

                contractAddressTransactions.forEach((tx) => {
                    if (tx.to.toLowerCase() === contract.toLowerCase()) {
                        buyersTxTr.add(tx.hash);
                    }
                });

                let totalTokens = 0;

                await Promise.all(
                    Array.from(buyersTxTr).map(async (i) => {
                        try {
                            const transactionReceipt = await web3.eth.getTransactionReceipt(i);

                            const wethBuyLog = transactionReceipt.logs.filter(
                                (logItem) => logItem.address.toLowerCase() === addressState.toLowerCase() && logItem.topics.length === 3
                            );

                            wethBuyLog.forEach((log) => {
                                const decodedData = web3.eth.abi.decodeParameters(
                                    [
                                        {
                                            type: 'uint256',
                                            name: '_value',
                                        },
                                    ],
                                    log.data,
                                );

                                const tokenAmount = decodedData._value / 10 ** decimals;
                                totalTokens += tokenAmount;
                            });
                        } catch (error) {
                            console.error('An error occurred:', error);
                        }
                    })
                );

                let transfer = false;

                await Promise.all(uniqueData.map(async (item, index) => {
                    const transactionReceipt = await web3.eth.getTransactionReceipt(item.hash);
                    const transaction = await web3.eth.getTransaction(item.hash);
                    const methodId = transaction.input.slice(0, 10);

                    if (methodId === '0xa9059cbb') {
                        transfer = true;
                    }

                    const wethLog = transactionReceipt.logs.filter(logItem => logItem.address === '0x4200000000000000000000000000000000000006' && logItem.topics.length === 2);

                    let totalEthAmount = 0;
                    const uniqueWethLog = Array.from(
                        wethLog.reduce((map, obj) => map.set(obj.data, obj), new Map()).values()
                    )

                    uniqueWethLog.map(logItem => {
                        const decodedData = web3.eth.abi.decodeParameters(
                            [
                                {
                                    type: 'uint256',
                                    name: '_value',
                                }
                            ],
                            logItem.data,
                        );
                        const ethAmount = Web3.utils.fromWei(decodedData._value, 'ether');
                        totalEthAmount += parseFloat(ethAmount);
                    });

                    ethResults[index] = {from: item.from, to: item.to, hash: item.hash, totalEthAmount};
                }));

                ethResults.forEach(result => {
                    if (result.to.toLowerCase() === contract.toLowerCase()) {
                        totalSpent += result.totalEthAmount;
                    }
                    if (result.from.toLowerCase() === contract.toLowerCase()) {
                        totalReceived += result.totalEthAmount;
                    }
                });

                const tokenPrice = await getTokenPrice(addressState);
                let priceInUSD = tokenPrice?.value ? tokenPrice?.value : 0;

                let balanceInUSD
                let tokenBalance;
                if (balance?.valueUsd) {
                    balanceInUSD = balance.valueUsd / ethereumPrice;
                    tokenBalance = balance.valueUsd < 100 ? 0 : balanceInUSD - totalSpent;
                } else {
                    balanceInUSD = (balanceInToken * priceInUSD) / ethereumPrice;
                    tokenBalance = (balanceInToken * priceInUSD) < 100 ? 0 : balanceInUSD - totalSpent;
                }


                const profit = totalReceived - totalSpent;

                const pnl = Number(balanceInUSD.toFixed(10)) + Number(profit.toFixed(3));

                const acquisitionPrice = Number(totalSpent.toFixed(3)) / totalTokens;

                results.push({
                    walletAddress: contract,
                    countTransactions: `# ${addressListTransactions.length}`,
                    pnl: pnl.toFixed(3),
                    balance: tokenBalance === 0 ? 0 : tokenBalance.toFixed(3),
                    profit: profit.toFixed(3),
                    totalSpent: totalSpent.toFixed(3),
                    acquisitionPrice: acquisitionPrice.toFixed(15),
                    transfer: `${transfer ? 'TRUE' : 'FALSE'}`,
                    contractAddress: addressState,
                    token: symbol,
                });
            } catch (error) {
                console.log(`Error address - ${wallet}`, error)
            }
        }));
    }

    const path = `$${contactSymbol} - ${addressState}.xlsx`;


    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Results');

    worksheet.columns = [
        {header: 'Wallet', key: 'walletAddress', width: 50},
        {header: 'trns', key: 'countTransactions', width: 10},
        {header: 'PnL', key: 'pnl', width: 10},
        {header: 'Spent', key: 'totalSpent', width: 10},
        {header: 'Transfer', key: 'transfer', width: 10},
        {header: 'unPnL', key: 'balance', width: 10},
        {header: 'realPnL', key: 'profit', width: 15},
        {header: 'Acquisition Price, Ξ', key: 'acquisitionPrice', width: 25},
        {header: 'Contract Address', key: 'contractAddress', width: 50},
        {header: 'Token', key: 'token', width: 10},
    ];

    const greenFill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {argb: 'FFEAf7E8'}
    };

    const redFill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {argb: 'FFF5E9E8'}
    };

    const trueFill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {argb: 'FFF2A6A3'}
    };

    const falseFill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {argb: 'FF83B38B'}
    };

    worksheet.getRow(1).eachCell((cell, colNumber) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {argb: 'FFBFBFBF'},
        };

        cell.font = {
            name: 'Calibri (Body)',
            size: 14,
            family: 2,
        };

        if (colNumber === 3) {
            cell.fill = greenFill;
        } else if (colNumber === 4) {
            cell.fill = redFill;
        }
    });

    const borderStyle = {
        top: {style: 'thin', color: {argb: 'FFBFBFBF'}},
        left: {style: 'thin', color: {argb: 'FFBFBFBF'}},
        bottom: {style: 'thin', color: {argb: 'FFBFBFBF'}},
        right: {style: 'thin', color: {argb: 'FFBFBFBF'}},
    };

    worksheet.views = [
        {state: 'frozen', ySplit: 1}
    ];

    results.sort((a, b) => b.pnl - a.pnl);

    results.forEach((result, index) => {
        const row = worksheet.addRow(result);
        row.eachCell((cell, colNumber) => {
            cell.border = borderStyle;
            cell.font = {
                name: 'Calibri (Body)',
                size: 14,
                family: 2,
            };


            if (colNumber === 6) {
                cell.fill = result.transfer === 'TRUE' ? trueFill : falseFill;
            }

            if (colNumber === 3) {
                cell.fill = greenFill;
            } else if (colNumber === 4) {
                cell.fill = redFill;
            }
        });
    });

    await workbook.xlsx.writeFile(path);

    if (fs.existsSync(path)) {
        bot.sendDocument(chatId, path)
            .then(() => {
                fs.unlinkSync(path);
                const options = {
                    reply_markup: JSON.stringify({
                        inline_keyboard: [
                            [{text: 'Wallet address', callback_data: 'option1'}],
                            [{text: 'Contract address', callback_data: 'option2'}],
                            [{text: 'Wallet addresses', callback_data: 'option3'}],
                        ]
                    })
                };
                bot.sendMessage(chatId, 'Choose an option:', options);
            });
    }
};

module.exports = {contractSingleDateParser};
