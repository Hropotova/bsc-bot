const tokenHolders = async (value, bot, chatId, addressState) => {
    try {
        let page = 1;
        let allOwners = [];

        while (true) {
            const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "getTokenAccounts",
                    id: "helius-test",
                    params: {
                        page: page,
                        limit: 1000,
                        displayOptions: {},
                        mint: addressState,
                    },
                }),
            });
            const data = await response.json();
            if (!data.result || data.result.token_accounts.length === 0) {
                console.log(`No more results. Total pages: ${page - 1}`);
                break;
            }
            console.log(`Processing results from page ${page}`);
            data.result.token_accounts.forEach((account) =>
                allOwners.push(account)
            );
            page++;
        }
        const sortedOwners = allOwners.map(i => {
            return {
                owner: i.owner,
                amount: i.amount / Math.pow(10, 9)
            }
        });

        const slicesSortedOwners = sortedOwners.sort((a, b) => {
            const nameA = a.amount;
            const nameB = b.amount;
            if (nameA > nameB) {
                return -1;
            }
            if (nameA < nameB) {
                return 1;
            }

            return 0;
        }).slice(0, value)

        const sendLargeMessageByOwners = async (chatId, ownersList) => {
            const MAX_OWNERS_PER_MESSAGE = 91;
            const owners = ownersList.split('\n');
            for (let i = 0; i < owners.length; i += MAX_OWNERS_PER_MESSAGE) {
                const partOwners = owners.slice(i, i + MAX_OWNERS_PER_MESSAGE).join('\n');
                // Await the sendMessage call to ensure messages are sent in order
                await bot.sendMessage(chatId, `\`${partOwners}\``, { parse_mode: 'MarkdownV2' });
            }
            const options = {
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [{text: 'Wallet address', callback_data: 'option1'}],
                        [{text: 'Contract address', callback_data: 'option2'}],
                        [{text: 'Token holders', callback_data: 'option3'}],
                    ]
                })
            };
            // Send the options message last
            await bot.sendMessage(chatId, 'Choose an option:', options);
        };

        const ownersList = slicesSortedOwners.map(i => `${i.owner}`).join('\n');
        sendLargeMessageByOwners(chatId, ownersList)
            .then(() => console.log('All messages sent successfully'))
            .catch(error => console.error('An error occurred', error));

    } catch (error) {
        console.error(`Помилка при обробці гаманця: ${addressState}`);
        console.error(error);
    }
};

module.exports = {tokenHolders};
