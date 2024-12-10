require('dotenv').config();
const axios = require('axios');

async function getAddressTokenTransaction(address, retryCount = 0) {
    const MAX_RETRIES = 5;

    try {
        const response = await axios.get(`${process.env.SCAN_URL}?module=account&action=tokentx&address=${address}&startblock=0&endblock=999999999&sort=asc&apikey=${process.env.SCAN_API_KEY}`);

        const result = response.data.result || [];

        if (Array.isArray(result) && result.length === 0 && retryCount < MAX_RETRIES) {
            console.log(`Attempt ${retryCount + 1}: Empty result, retrying in 1 second...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return getAddressTokenTransaction(address, retryCount + 1);
        }

        return result;
    } catch (error) {
        console.error('Error fetching data:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return getAddressTokenTransaction(address, retryCount);
    }
}

async function getAddressListTransaction(address) {
    try {
        const response = await axios.get(`${process.env.SCAN_URL}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&apikey=${process.env.SCAN_API_KEY}`);

        return response.data.result;
    } catch (error) {
        console.error('Error fetching data:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return getAddressListTransaction(address);
    }
}

async function getInternalTransactions(hash) {
    try {
        const response = await axios.get(`${process.env.SCAN_URL}?module=account&action=txlistinternal&hash=${hash}&apikey=${process.env.SCAN_API_KEY}`);

        return response.data.result;
    } catch (error) {
        console.error('Error fetching data:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return getInternalTransactions(hash);
    }
}

async function getContractAddressTransactions(address, contract) {
    try {
        const response = await axios.get(`${process.env.SCAN_URL}?module=account&action=tokentx&address=${address}&contractaddress=${contract}&apikey=${process.env.SCAN_API_KEY}`);

        const transactions = response.data.result;

        const uniqueTransactions = transactions.filter((transaction, index, self) =>
            index === self.findIndex(t => t.hash === transaction.hash)
        );

        return uniqueTransactions;
    } catch (error) {
        console.error('Error fetching contract address transactions:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return getContractAddressTransactions(address, contract);
    }
}

async function getAddressTransactionsSorted(address) {
    try {
        const response = await axios.get(`${process.env.SCAN_URL}?module=account&action=tokentx&contractaddress=${address}&startblock=0&endblock=99999999&sort=asc&apikey=${process.env.SCAN_API_KEY}`);

        return response.data.result;
    } catch (error) {
        console.error('Error fetching sorted transactions:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return getAddressTransactionsSorted(address);
    }
}

module.exports = {
    getAddressTokenTransaction,
    getAddressListTransaction,
    getContractAddressTransactions,
    getAddressTransactionsSorted,
    getInternalTransactions
};
