require('dotenv').config();
const fs = require('fs');

const {getWalletTokenSwaps, getWalletTokenBalances, getActiveWalletChains} = require('../api/moralis');
const {getChainPrice} = require('../api/crypto');

const walletParser = async (addresses, bot, chatId) => {
    const splitAddresses = addresses.split('\n');

    // Get price of the chain's native token: Ethereum, Binance coin...
    const chainPrice = await getChainPrice();

    // Process each wallet address one by one
    for (const address of splitAddresses) {
        try {
            // Get all swap related transactions (buy, sell)
            const swaps = await getWalletTokenSwaps(address);

            // Get token balances for a specific wallet address.
            const balances = await getWalletTokenBalances(address);

            // Get the active chains for a wallet address.
            const chains = await getActiveWalletChains(address);

            // Calculate and decode swaps
            const tokenData = {};

            for (const swap of swaps) {
                const {bought, sold, blockTimestamp, transactionHash} = swap;
                if (!bought || !sold) continue;

                const boughtSymbol = bought.symbol;
                const soldSymbol = sold.symbol;
                const boughtAddress = bought.address;
                const soldAddress = sold.address;

                // Handle BUY transactions (spending WBNB)
                if (soldSymbol === 'WBNB') {
                    const token = boughtSymbol;
                    if (!tokenData[token]) {
                        tokenData[token] = {
                            boughtAmount: 0,
                            soldAmount: 0,
                            wbnbSpent: 0,
                            wbnbReceived: 0,
                            contractAddress: boughtAddress,
                            balance: 0,
                        };
                    }
                    tokenData[token].boughtAmount += parseFloat(bought.amount);
                    tokenData[token].wbnbSpent += Math.abs(parseFloat(sold.amount));
                }

                // Handle SELL transactions (receiving WBNB)
                if (boughtSymbol === 'WBNB') {
                    const token = soldSymbol;
                    if (!tokenData[token]) {
                        tokenData[token] = {
                            boughtAmount: 0,
                            soldAmount: 0,
                            wbnbSpent: 0,
                            wbnbReceived: 0,
                            contractAddress: soldAddress,
                            balance: 0,
                        };
                    }
                    tokenData[token].soldAmount += Math.abs(parseFloat(sold.amount));
                    tokenData[token].wbnbReceived += parseFloat(bought.amount);
                }
            }

            // Convert USD balances to WBNB equivalents
            for (const token of balances) {
                const symbol = token.symbol;
                if (tokenData[symbol]) {
                    const usdValue = token.usd_value || 0;
                    tokenData[symbol].balance = usdValue / chainPrice;
                }
            }

            // Add calculated data to JSON
            const addressData = {};

            for (const [symbol, stats] of Object.entries(tokenData)) {
                // Calculate PnL for the token: balance + (received - spent)
                const pnl = stats.balance + (stats.wbnbReceived - stats.wbnbSpent);

                // Add active chains to the JSON
                addressData.activeChains = chains;

                // Add token data to the JSON
                addressData[stats.contractAddress] = {
                    symbol,
                    pnl: Number(pnl.toFixed(4)),
                    spent: Number(stats.wbnbSpent.toFixed(4)),
                    transfer: 'FALSE',
                };
            }

            const filePath = `${address}.json`;
            fs.writeFileSync(filePath, JSON.stringify({[address]: addressData}, null, 2));

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
