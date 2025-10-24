const axios = require('axios');
const config = require('../../config');

const JSON_MIME = 'application/json';

function isEvmAddress(s) {
    return /^0x[a-fA-F0-9]{40}$/.test(String(s || '').trim());
}

function ensurePrefix(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    return u.endsWith('/') ? u : `${u}/`;
}

function getChainConf(chainKey) {
    const conf = config?.[chainKey];
    if (!conf) {
        throw new Error(`Unknown chainKey "${chainKey}". Available: ${Object.keys(config).join(', ')}`);
    }

    const chain_id = String(conf.chain_id);
    const dextools_prefix = ensurePrefix(conf.dextools_parse_url);
    const dexscreener_prefix = ensurePrefix(conf.dexscreener_parse_url);

    if (!dextools_prefix || !dexscreener_prefix) {
        throw new Error(
            `Config for "${chainKey}" must contain dextools_parse_url and dexscreener_parse_url`
        );
    }
    return { chain_id, dextools_prefix, dexscreener_prefix };
}

async function processTokenContract(contract, bot, chatId, chainKey) {
    try {
        const input = String(contract || '').trim();
        if (!isEvmAddress(input)) {
            await bot.sendMessage(chatId, 'Please send a valid contract address (0x + 40 hex).');
            return;
        }

        const { chain_id, dextools_prefix, dexscreener_prefix } = getChainConf(chainKey);
        const dextools_parse_url = `${dextools_prefix}${input}`;
        const dexscreener_parse_url = `${dexscreener_prefix}${input}`;

        const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://157.245.176.230:3333';

        // ЛИШЕ JSON
        const jsonRes = await axios.post(
            `${COLLECTOR_URL}/collect`,
            { dextools_parse_url, dexscreener_parse_url, chain_id },
            { timeout: 60_000 }
        );

        const pretty = JSON.stringify(jsonRes.data, null, 2);
        const filename = `${input}_${chain_id}.json`;

        await bot.sendChatAction(chatId, 'upload_document');
        await bot.sendDocument(
            chatId,
            Buffer.from(pretty, 'utf8'),
            { caption: `Addresses JSON (chain ${chain_id})` },
            { filename, contentType: JSON_MIME }
        );
    } catch (e) {
        console.error('processTokenContract error:', e?.response?.data || e.message || e);
        await bot.sendMessage(chatId, 'Sourcer: error while processing the contract.');
    }
}

module.exports = { processTokenContract };
