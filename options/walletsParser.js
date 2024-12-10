const Web3 = require('web3');
const fs = require('fs');
const ExcelJS = require('exceljs');

const {
    getAddressTokenTransaction,
    getAddressListTransaction,
    getContractAddressTransactions
} = require('../api/scan');
const {getEthereumPrice, getTokenPrice} = require('../api/crypto');
const {ERC20_ABI} = require('../constants/erc2_abi');

const web3 = new Web3(process.env.PROVIDER);

const walletsParser = async (addresses, bot, chatId) => {
    let allResults = [];
    const sortAddresses = addresses.split('\n');
    await Promise.all(sortAddresses.map(async (address) => {
        const addressTokenTransactions = await getAddressTokenTransaction(address);

        const sortedTransactions = addressTokenTransactions.sort((a, b) => b.blockNumber - a.blockNumber);
        let recentTokenContracts;
        if (sortedTransactions.length >= 250) {
            recentTokenContracts = [...new Set(sortedTransactions.map(tx => tx.contractAddress))].slice(0, 15);
        } else {
            recentTokenContracts = [...new Set(sortedTransactions.map(tx => tx.contractAddress))];
        }

        const groupedTransactions = recentTokenContracts.map(contractAddress => {
            return addressTokenTransactions.filter(tx => tx.contractAddress === contractAddress);
        });

        const transactionMap = {};
        groupedTransactions.forEach(transactions => {
            if (transactions.length > 0) {
                transactionMap[transactions[0].contractAddress] = transactions;
            }
        });
        let results = [];

        const addressListTransactions = await getAddressListTransaction(address);
        const ethereumPrice = await getEthereumPrice();

        for (let contract of recentTokenContracts) {

            const tokenContract = new web3.eth.Contract(ERC20_ABI, contract);
            const symbol = await tokenContract.methods.symbol().call();
            const decimals = await tokenContract.methods.decimals().call();
            const balance = await tokenContract.methods.balanceOf(address).call();
            const balanceInToken = balance / Math.pow(10, decimals);

            const tokenPrice = await getTokenPrice(contract);
            let priceInUSD = tokenPrice?.value ? tokenPrice?.value : 0;
            let tokenLiquidity = tokenPrice?.liquidity ? tokenPrice?.liquidity / ethereumPrice : 100000000000000;

            let scamFlags;
            let blockNumber

            const ethResults = [];

            let totalSpent = 0;
            let totalReceived = 0;
            const responseData = transactionMap[contract] || [];
            const uniqueData = Array.from(
                responseData.reduce((map, obj) => map.set(obj.hash, obj), new Map()).values()
            );

            const contractAddressTransactions = await getContractAddressTransactions(address, contract);

            const buyersTxTr = new Set();
            let totalGasPrice;

            if (contractAddressTransactions.length === 0) {
                totalGasPrice = 0
            } else {
                totalGasPrice = Number(web3.utils.fromWei(contractAddressTransactions[0].gasPrice, 'Gwei'));
            }

            contractAddressTransactions.forEach((tx) => {
                if (tx.to.toLowerCase() === contract.toLowerCase()) {
                    buyersTxTr.add(tx.hash);
                }
            });

            let totalTokens = 0;

            await Promise.all(
                Array.from(uniqueData).map(async (i) => {
                    try {
                        const transactionReceipt = await web3.eth.getTransactionReceipt(i.hash);

                        const wethBuyLog = transactionReceipt.logs.filter(
                            (logItem) => logItem.address.toLowerCase() === contract.toLowerCase() && logItem.topics.length === 3
                        );

                        wethBuyLog.forEach((log) => {
                            const decodedData = web3.eth.abi.decodeParameters(
                                [
                                    {
                                        type: 'uint256',
                                        name: '_value',
                                    },
                                ],
                                log.data
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
            let scamDelete = false;
            let snipe = false;
            let manual = false;

            await Promise.all(uniqueData.map(async (item, index) => {
                const transactionReceipt = await web3.eth.getTransactionReceipt(item.hash);
                const transaction = await web3.eth.getTransaction(item.hash);
                if (scamFlags) {
                    if (transaction.blockNumber <= blockNumber) {
                        snipe = true;
                    } else {
                        manual = true;
                    }
                }
                const methodId = transaction.input.slice(0, 10);
                if (methodId === '0xa9059cbb') {
                    transfer = true;
                }
                if (transaction.from.toLocaleLowerCase() !== address.toLocaleLowerCase()) {
                    scamDelete = true
                }
                let wethLog = transactionReceipt.logs.filter(logItem => logItem.address === '0x4200000000000000000000000000000000000006' && logItem.topics.length === 2);
                if (wethLog.length === 0) {
                    wethLog = transactionReceipt.logs.filter(logItem => logItem.address === '0x4200000000000000000000000000000000000006' && logItem.topics.length === 3);
                }
                let totalEthAmount = 0;
                const uniqueWethLog = Array.from(
                    wethLog.reduce((map, obj) => map.set(obj.data, obj), new Map()).values()
                );
                uniqueWethLog.map(logItem => {
                    const decodedData = web3.eth.abi.decodeParameters(
                        [
                            {
                                type: 'uint256',
                                name: '_value'
                            }
                        ],
                        logItem.data
                    );
                    const ethAmount = Web3.utils.fromWei(decodedData._value, 'ether');
                    totalEthAmount += parseFloat(ethAmount);
                });

                ethResults[index] = {from: item.from, to: item.to, hash: item.hash, totalEthAmount};
            }));

            ethResults.forEach(result => {
                if (result.to.toLowerCase() === address.toLowerCase()) {
                    totalSpent += result.totalEthAmount;
                }
                if (result.from.toLowerCase() === address.toLowerCase()) {
                    totalReceived += result.totalEthAmount;
                }
            });
            let balanceInETH;

            if (balance?.valueUsd) {
                balanceInETH = (balance ? balance.valueUsd : 0) / ethereumPrice || 0;
            } else {
                balanceInETH = (balanceInToken * priceInUSD) / ethereumPrice || 0;
            }

            if (tokenLiquidity < process.env.LIQUIDITY) {
                console.log('liquidity', tokenLiquidity)
                balanceInETH = 0
            }

            const realisedProfit = totalReceived - totalSpent;
            const unrealisedProfit = balanceInETH - totalSpent;

            let pnl
            if (scamFlags) {
                pnl = Number(realisedProfit.toFixed(3));
            } else {
                pnl = Number(balanceInETH.toFixed(10)) + Number(realisedProfit.toFixed(3));
            }
            const acquisitionPrice = Number(totalSpent.toFixed(10)) / totalTokens;

            const statusToken = pnl > totalSpent * 2;

            results.push({
                token: {
                    text: `${statusToken ? '🟢' : '🔴'}${symbol} ${transfer ? '🔀' : ''}${scamFlags ? '🍯' : ''}`,
                    hyperlink: `https://etherscan.io/token/${contract}`
                },
                countTransactions: addressListTransactions.length,
                pnl: pnl.toFixed(3),
                unrealisedProfit: `${unrealisedProfit.toFixed(10)}`,
                avgGasPrice: `⛽️ ${totalGasPrice.toFixed(0)}`,
                acquisitionPrice: acquisitionPrice.toFixed(15),
                contractAddress: contract,
                scam: `${scamFlags ? 'TRUE' : 'FALSE'}`,
                totalSpent: totalSpent.toFixed(3),
                totalReceived: totalReceived.toFixed(3),
                realisedProfit: realisedProfit.toFixed(3),
                pnlSpent: `(${pnl.toFixed(3)} / ${totalSpent.toFixed(3)}, Ξ)`,
                transfer: `${transfer ? 'TRUE' : 'FALSE'}`,
                scamDelete: scamDelete,
                type: snipe ? `🔫 ${manual ? '✋' : ''}` : '✋',
            });
        }

        let resultsForAddress = {
            address: address,
            results: results,
            totalTransactions: addressListTransactions.length,
        };

        allResults.push(resultsForAddress);
    }))
    const path = `results.xlsx`;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Results');

    worksheet.columns = [
        {header: 'Token', key: 'token', width: 10},
        {header: 'Pnl / Spent , , Ξ', key: 'pnlSpent', width: 15},
        {header: 'Gas', key: 'avgGasPrice', width: 10},
        {header: 'type', key: 'type', width: 8},
    ];

    worksheet.getRow(1).eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {argb: 'FFBFBFBF'},
        };
    });

    let currentRow = 2;

    allResults.forEach(({address, results, totalTransactions}) => {
        const addressRow = worksheet.addRow(["T#: " + totalTransactions, "Address: " + address]);
        const addressLink = `https://etherscan.io/address/${address}`;
        const addressCell = addressRow.getCell(2);
        addressCell.value = {
            text: address,
            hyperlink: addressLink,
        };
        addressCell.style = {font: {color: {argb: 'FF0000FF'}, underline: true}};

        // Застосуємо шрифт до всіх комірок у рядку.
        addressRow.eachCell(cell => {
            cell.font = {
                name: 'Calibri (Body)',
                size: 12,
                bold: true,
            };
        });

        currentRow++;

        results = results.filter(result => result.pairAddress !== 'pair not found');
        results = results.filter(result => !(result.scamDelete === true && result.scam === 'TRUE'));
        results.sort((a, b) => b.pnl - a.pnl);

        results.forEach((result) => {
            worksheet.addRow(result);
        });

        currentRow += results.length;
        currentRow++;
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
}

module.exports = {walletsParser};
