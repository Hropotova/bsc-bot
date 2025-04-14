
require('dotenv').config();
const fs = require('fs');

const {getWalletTokenSwaps, getWalletTokenBalances, getActiveWalletChains, getTokenPrice} = require('../api/moralis');
const {getAllTransactions} = require('../api/scan');
const {checkTransactionHistory} = require('../services/checkTransactionHistory');

const walletParser = async (addresses, bot, chatId) => {
    const splitAddresses = addresses.split('\n');

    // Get BNB price in USD
    const bnbPrice = await getTokenPrice('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');

    // Process each wallet address one by one
    for (const address of splitAddresses) {
        try {
            // Get all transactions for the wallet address.
            const transactions = await getAllTransactions(address);

            if (transactions.length < process.env.TRANSACTIONS_COUNT) {

                // Get all swap related transactions (buy, sell).
                const swaps = await getWalletTokenSwaps(address);

                // Get token balances for a specific wallet address.
                const balances = await getWalletTokenBalances(address);

                // Get the active chains for a wallet address.
                const chains = await getActiveWalletChains(address);

                // Get lost swaps and transfers.
                const {lostSwaps, transfers} = await checkTransactionHistory(address, swaps);

                const tokenData = {};

                // Compare the swaps with the lost swaps.
                const allSwaps = [...swaps, ...lostSwaps];

                for (const swap of allSwaps) {
                    const {bought, sold, transactionType} = swap;
                    if (!bought || !sold) continue;

                    const boughtSymbol = bought.symbol;
                    const soldSymbol = sold.symbol;
                    const boughtAddress = bought.address;
                    const soldAddress = sold.address;

                    // Handle BUY transactions.
                    if (transactionType === 'buy') {
                        const token = boughtAddress;
                        if (!tokenData[token]) {
                            tokenData[token] = {
                                boughtAmount: 0,
                                soldAmount: 0,
                                spent: 0,
                                received: 0,
                                contractAddress: boughtAddress,
                                symbol: boughtSymbol,
                                balance: 0,
                                trades: []
                            };
                        } else if (!tokenData[token].trades) {
                            tokenData[token].trades = [];
                        }
                        tokenData[token].boughtAmount += parseFloat(bought.amount);
                        tokenData[token].spent += Math.abs(parseFloat(sold.amount));
                        tokenData[token].trades.push(swap);
                    }

                    // Handle SELL transactions.
                    if (transactionType === 'sell') {
                        const token = soldAddress;
                        if (!tokenData[token]) {
                            tokenData[token] = {
                                boughtAmount: 0,
                                soldAmount: 0,
                                spent: 0,
                                received: 0,
                                contractAddress: soldAddress,
                                symbol: soldSymbol,
                                balance: 0,
                            };
                        } else if (!tokenData[token].trades) {
                            tokenData[token].trades = [];
                        }
                        tokenData[token].soldAmount += Math.abs(parseFloat(sold.amount));
                        tokenData[token].received += parseFloat(bought.amount);
                        tokenData[token].trades.push(swap);
                    }
                }


                // Convert USD balances to WBNB equivalents.
                for (const token of balances) {
                    const contractAddress = token.token_address;
                    if (tokenData[contractAddress]) {
                        const usdValue = token.usd_value || 0;
                        tokenData[contractAddress].balance = usdValue / bnbPrice.usdPrice.toFixed(4);
                    }
                }

                // Add calculated data to JSON.
                const addressData = {
                    target_chain: 'bsc', // Add target chain from .env file to the JSON.
                    active_chains: chains, // Add active chains to the JSON
                    address_info: {
                        total_transactions: transactions.length,
                        total_tokens_traded: Object.entries(tokenData).length,
                    },
                    traded_tokens: {},
                };

                for (const [contract, stats] of Object.entries(tokenData)) {
                    console.log(stats.trades);
                    // Calculate PnL for the token: balance + (received - spent).
                    const realizedPnl = stats.balance + (stats.received - stats.spent);

                    // Count inflow and outflow transactions.
                    let inflow_count = 0;
                    let outflow_count = 0;

                    const tokenTransfers = transfers.filter(i => i.contract === contract);

                    tokenTransfers.forEach(transfer => {
                        if (transfer.from.toLowerCase() === address.toLowerCase()) {
                            outflow_count++;
                        }
                        if (transfer.to.toLowerCase() === address.toLowerCase()) {
                            inflow_count++;
                        }
                    });

                    // Add token data to the JSON.
                    addressData.traded_tokens[contract] = {
                        symbol: stats.symbol,
                        spent: Number(stats.spent.toFixed(4)),
                        pnl: {
                            total: Number(realizedPnl.toFixed(4)),
                            realized: Number(stats.received.toFixed(4)),
                            unrealized: Number(stats.balance.toFixed(4)),
                        },
                        transfers: {
                            inflow_count,
                            outflow_count,
                        },
                    };
                }

                const filePath = `${address}.json`;
                fs.writeFileSync(filePath, JSON.stringify({[address]: addressData}, null, 2));

                const options = {
                    caption: `\`${address}\``,
                    parse_mode: 'Markdown',
                };

                await bot.sendDocument(chatId, filePath, options);
                fs.unlinkSync(filePath);

                const menuOptions = {
                    reply_markup: JSON.stringify({
                        inline_keyboard: [
                            [{text: 'Wallet address', callback_data: 'option1'}],
                        ]
                    })
                };
                await bot.sendMessage(chatId, 'Choose an option:', menuOptions);
            } else {
                bot.sendMessage(chatId, `Transactions count address more then ${process.env.TRANSACTIONS_COUNT} \n\`${address}\``, {
                    parse_mode: 'MarkdownV2',
                });
                const menuOptions = {
                    reply_markup: JSON.stringify({
                        inline_keyboard: [
                            [{text: 'Wallet address', callback_data: 'option1'}],
                        ]
                    })
                };
                await bot.sendMessage(chatId, 'Choose an option:', menuOptions);
            }
        } catch (error) {
            console.error(`Error parsing wallet ${address}:`, error.message);
            await bot.sendMessage(chatId, `Error parsing wallet \`${address}\`: ${error.message}`, {parse_mode: 'Markdown'});
        }
    }
};

module.exports = {walletParser};
