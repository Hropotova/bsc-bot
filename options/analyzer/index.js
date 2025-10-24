const fs = require('fs');

const {walletParserCore} = require('./core');

const config = require('../../config.js');

async function walletParserSingleChain(addresses, bot, chatId, chainKey) {
    await walletParserCore(addresses, bot, chatId, [chainKey]);
}

async function walletParserMultiChain(addresses, bot, chatId) {
    const allChains = Object.keys(config);
    await walletParserCore(addresses, bot, chatId, allChains);

    const addrs = addresses.split('\n').map(a => a.trim()).filter(a => a);
    for (const address of addrs) {
        const multi = {};
        for (const chainKey of allChains) {
            const fn = `${address}_${chainKey}.json`;
            if (fs.existsSync(fn)) {
                multi[chainKey] = require(process.cwd() + '/' + fn)[address];
                fs.unlinkSync(fn);
            }
        }
    }
}

module.exports = {walletParserSingleChain, walletParserMultiChain};
