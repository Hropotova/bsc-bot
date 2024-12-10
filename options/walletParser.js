const fs = require('fs');
const ExcelJS = require('exceljs');
const Web3 = require('web3');
const Bottleneck = require('bottleneck');

const {
    getAddressTokenTransaction,
    getAddressListTransaction,
} = require('../api/scan');
const {getEthereumPrice} = require('../api/crypto');
const {honeypotChecker} = require('../services/honeypotChecker');
const {transactionsDecod} = require('../services/transactionsDecod');

const web3 = new Web3(process.env.PROVIDER);

const limiter = new Bottleneck({
    minTime: 200,
    maxConcurrent: 1,
});

const walletParser = async (addresses, bot, chatId) => {
    const sortAddresses = addresses.split('\n');
    const ethereumPrice = await getEthereumPrice();

    for (const address of sortAddresses) {
        const code = await web3.eth.getCode(address);
        console.log('ADDRESS —', address)
        if (code === '0x') {
            try {
                const addressListTransactions = await getAddressListTransaction(address);

                console.log('COUNT TRANSACTIONS —', addressListTransactions.length);

                if (addressListTransactions.length < process.env.TRANSACTIONS_COUNT) {
                    const addressTokenTransactions = await getAddressTokenTransaction(address);

                    const tokenContracts = [...new Set(addressTokenTransactions.map(tx => tx.contractAddress))].slice(0.10);
                    const groupedTransactions = tokenContracts.map(contractAddress => {
                        return addressTokenTransactions.filter(tx => tx.contractAddress === contractAddress);
                    });
                    const transactionMap = {};
                    groupedTransactions.forEach(transactions => {
                        if (transactions.length > 0) {
                            transactions.forEach(transaction => {
                                const contractAddressKey = transaction.contractAddress.toLowerCase();
                                const hashKey = transaction.hash;
                                if (!transactionMap[contractAddressKey]) {
                                    transactionMap[contractAddressKey] = {};
                                }
                                transactionMap[contractAddressKey][hashKey] = transaction;
                            });
                        }
                    });

                    console.log('CONTRACTS ON WALLET —', tokenContracts.length);

                    const limitedHoneypot = limiter.wrap(honeypotChecker);

                    const honeypotFilter = async (contracts) => {
                        const honeypotContracts = await Promise.all(
                            contracts.map(contract => limitedHoneypot(contract))
                        );

                        return honeypotContracts
                            .filter(result => result.scam === false)
                            .map(result => result.contract);
                    };

                    const filteredContracts = await honeypotFilter(tokenContracts);

                    console.log('FILTERED HONEYPOT CONTRACTS —', filteredContracts.length);
                    const limitedContracts = limiter.wrap(transactionsDecod);

                    const contractsParser = async (contracts) => {
                        const calculateContracts = await Promise.all(
                            contracts.map(contract => limitedContracts(contract, address))
                        );

                        return calculateContracts;
                    };

                    const calculatedData = await contractsParser(filteredContracts);
                    const calculateWethPnL = (calculatedData) => {
                        return calculatedData.map(item => {
                            let wethStats = {sent: 0, received: 0};

                            if (item && item.totalSent) {
                                item.totalSent.forEach(sentItem => {
                                    if (sentItem.token === 'WBNB') {
                                        wethStats.sent += sentItem.value;
                                    }
                                });
                            }

                            if (item && item.totalReceive) {
                                item.totalReceive.forEach(receiveItem => {
                                    if (receiveItem.token === 'WBNB') {
                                        wethStats.received += receiveItem.value;
                                    }
                                });
                            }

                            const tokenBalanceETH = (item.balance * item.price) / ethereumPrice;

                            const pnl = tokenBalanceETH + (wethStats.received - wethStats.sent);

                            return {
                                contract: item.contract || '',
                                symbol: item.symbol,
                                transfer: item.transfer,
                                sent: wethStats.sent,
                                pnl,
                            };
                        });
                    };

                    const wethPnL = calculateWethPnL(calculatedData);

                    let results = [];

                    const contractsOnly = wethPnL.filter(item => item.contract !== '');
                    contractsOnly.forEach(result => {
                        results.push(result);
                    });

                    const calculateAverage = (data) => {
                        const sum = data.reduce((acc, val) => acc + val, 0);
                        return sum / data.length;
                    };

                    const calculateStDev = (data, average) => {
                        const squareDiffs = data.map(value => Math.pow(value - average, 2));
                        return Math.sqrt(calculateAverage(squareDiffs));
                    };

                    const pnlValues = results.map(result => parseFloat(result.pnl));
                    const averagePnL = calculateAverage(pnlValues);
                    const stDevPnL = calculateStDev(pnlValues, averagePnL);

                    results.forEach(result => {
                        const zScore = (parseFloat(result.pnl) - averagePnL) / stDevPnL;
                        const winRate = parseFloat(result.pnl) > 0.1;

                        result.zScore = zScore;
                        result.winRate = winRate ? 'TRUE' : 'FALSE';
                    });

                    const workbook = new ExcelJS.Workbook();
                    const worksheet = workbook.addWorksheet('Results');


                    worksheet.columns = [
                        {header: 'Token', key: 'symbol', width: 10},
                        {header: 'PnL', key: 'pnl', width: 8},
                        {header: 'Spent, Ξ', key: 'sent', width: 10},
                        {header: 'Transfer', key: 'transfer', width: 10},
                        {header: 'Contract Address', key: 'contract', width: 50},
                        {header: 'Z-Score', key: 'zScore', width: 10},
                        {header: 'Win Rate', key: 'winRate', width: 10},
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

                    const inFill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: {argb: 'FFF2A6A3'}
                    };

                    const outFill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: {argb: 'FFFAB4D1'}
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

                        if (colNumber === 2) {
                            cell.fill = greenFill;
                        } else if (colNumber === 3) {
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

                    results = results.filter(result => ((result.scamDelete !== true)));
                    results = results.filter(result => ((Number(result.pnl) !== 0 && Number(result.totalSpent) !== 0)));
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

                            if (colNumber === 2) {
                                cell.fill = greenFill;
                            } else if (colNumber === 3) {
                                cell.fill = redFill;
                            }

                            if (colNumber === 4) {
                                if (result?.transfer === 'out') {
                                    cell.fill = outFill;
                                    cell.value = 'TRUE'
                                } else if (result?.transfer === 'in') {
                                    cell.fill = inFill;
                                    cell.value = 'TRUE'
                                } else {
                                    cell.fill = falseFill;
                                    cell.value = 'FALSE'
                                }
                            }
                        });
                    });

                    let winCount = 0;
                    let totalPnl = 0;

                    results.forEach((result) => {
                        if (parseFloat(result.pnl) > 0.08) {
                            winCount += 1;
                        }
                        totalPnl += parseFloat(result.pnl);
                    });
                    const winPercentage = (winCount / results.length) * 100;
                    const averagePnl = totalPnl / results.length;
                    if (winPercentage >= process.env.WIN_RATE && averagePnl >= process.env.AVARAGE_PNL) {
                        const path = `${winPercentage.toFixed(0)}% ${averagePnl.toFixed(2)}eth - ${address}.xlsx`;

                        await workbook.xlsx.writeFile(path);

                        const options = {
                            caption: `\`${address}\``,
                            parse_mode: 'MarkdownV2',
                        };

                        if (fs.existsSync(path)) {
                            bot.sendDocument(chatId, path, options)
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
                } else {
                    bot.sendMessage(chatId, `[${address}](https://dexcheck.ai/app/address-analyzer/${address}) \n\`${address}\``, {
                        parse_mode: 'MarkdownV2',
                    }).then(() => {
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

            } catch (error) {
                console.error(`Помилка при обробці гаманця: ${address}`);
                console.log(error)
            }
        }
    }
};

module.exports = {walletParser};
