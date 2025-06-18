const {associatedAddresses} = require('./AssociatedAddresses');
const {transactionsFrequency} = require('./TransactionFrequency');
const {createHistorySwaps} = require('./CreateHistorySwaps');
const {averageHoldingHours} = require('./AverageHoldingHours');
const {mergeVirtualTokens} = require('./MergeVirtualTokens');

module.exports = {
    associatedAddresses,
    transactionsFrequency,
    createHistorySwaps,
    averageHoldingHours,
    mergeVirtualTokens,
};
