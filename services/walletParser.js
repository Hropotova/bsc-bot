require('dotenv').config();
const fs = require('fs');

const {getWalletTokenSwaps, getWalletTokenBalances, getActiveWalletChains} = require('../api/moralis');

const walletParser = async (addresses, bot, chatId) => {
    const splitAddresses = addresses.split('\n');

    for (const address of splitAddresses) {
        try {
            // Get all swap related transactions (buy, sell)
            const swaps = await getWalletTokenSwaps(address);

            // Get token balances for a specific wallet address.
            const balances = await getWalletTokenBalances(address);

            // Get the active chains for a wallet address.
            const chains = await getActiveWalletChains(address);

            const tokenStats = {};

            for (const swap of swaps) {
                const {bought, sold, blockTimestamp, transactionHash} = swap;
                if (!bought || !sold) continue;

                const boughtSymbol = bought.symbol;
                const soldSymbol = sold.symbol;
                const boughtAddress = bought.address;
                const soldAddress = sold.address;

                if (soldSymbol === 'WBNB') {
                    const token = boughtSymbol;
                    if (!tokenStats[token]) {
                        tokenStats[token] = {
                            boughtAmount: 0,
                            soldAmount: 0,
                            wbnbSpent: 0,
                            wbnbReceived: 0,
                            contractAddress: boughtAddress,
                            balance: 0,
                            trades: []
                        };
                    }
                    tokenStats[token].boughtAmount += parseFloat(bought.amount);
                    tokenStats[token].wbnbSpent += Math.abs(parseFloat(sold.amount));
                    tokenStats[token].trades.push({
                        time: blockTimestamp,
                        hash: transactionHash,
                        action: 'buy',
                        pair: `WBNB/${token}`
                    });
                }

                if (boughtSymbol === 'WBNB') {
                    const token = soldSymbol;
                    if (!tokenStats[token]) {
                        tokenStats[token] = {
                            boughtAmount: 0,
                            soldAmount: 0,
                            wbnbSpent: 0,
                            wbnbReceived: 0,
                            contractAddress: soldAddress,
                            balance: 0,
                            trades: []
                        };
                    }
                    tokenStats[token].soldAmount += Math.abs(parseFloat(sold.amount));
                    tokenStats[token].wbnbReceived += parseFloat(bought.amount);
                    tokenStats[token].trades.push({
                        time: blockTimestamp,
                        hash: transactionHash,
                        action: 'sell',
                        pair: `${token}/WBNB`
                    });
                }
            }

            const bnbPrice = balances.find(t => t.symbol === 'BNB')?.usd_price || 600;

            for (const token of balances) {
                const symbol = token.symbol;
                if (tokenStats[symbol]) {
                    const usdValue = token.usd_value || 0;
                    const wbnbValue = usdValue / bnbPrice;
                    tokenStats[symbol].balance = wbnbValue;
                }
            }

            const walletData = {};
            for (const [symbol, stats] of Object.entries(tokenStats)) {
                stats.trades.sort((a, b) => new Date(a.time) - new Date(b.time));
                const pnl = stats.balance + (stats.wbnbReceived - stats.wbnbSpent);

                walletData[stats.contractAddress] = {
                    symbol,
                    activeChains: chains,
                    pnl: Number(pnl.toFixed(4)),
                    spent: Number(stats.wbnbSpent.toFixed(4)),
                    transfer: 'FALSE',
                    trades: stats.trades,
                };
            }

            const filePath = `${address}.json`;
            fs.writeFileSync(filePath, JSON.stringify({[address]: walletData}, null, 2));

            const options = {
                caption: `Results \`${address}\``,
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

        } catch (error) {
            console.error(`Error parsing wallet ${address}:`, error.message);
            await bot.sendMessage(chatId, `Error parsing wallet \`${address}\`: ${error.message}`, {parse_mode: 'Markdown'});
        }
    }
};

module.exports = {walletParser};
