/**
 * Performance Logger - утиліта для логування часу виконання
 */

class PerformanceLogger {
    constructor() {
        this.stats = new Map();
        this.addressStartTime = null;
        this.currentAddress = null;
    }

    // Початок обробки адреси
    startAddress(address) {
        this.currentAddress = address;
        this.addressStartTime = Date.now();
        this.stats.clear();
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🚀 START PROCESSING: ${address}`);
        console.log(`⏱️  Started at: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(80)}\n`);
    }

    // Кінець обробки адреси
    endAddress(address) {
        const total = Date.now() - this.addressStartTime;
        console.log(`\n${'='.repeat(80)}`);
        console.log(`✅ FINISHED PROCESSING: ${address}`);
        console.log(`⏱️  Total time: ${this.formatTime(total)}`);
        this.printSummary();
        console.log(`${'='.repeat(80)}\n`);
    }

    // Початок операції
    startOperation(category, operation, details = '') {
        const key = `${category}:${operation}`;
        const start = Date.now();

        if (!this.stats.has(category)) {
            this.stats.set(category, { calls: 0, totalTime: 0, operations: new Map() });
        }

        const detailStr = details ? ` [${details}]` : '';
        console.log(`  ▶️  ${category}.${operation}${detailStr}`);

        return { key, start, category, operation };
    }

    // Кінець операції
    endOperation(timer, cached = false) {
        const elapsed = Date.now() - timer.start;
        const { category, operation } = timer;

        const catStats = this.stats.get(category);
        catStats.calls++;
        catStats.totalTime += elapsed;

        if (!catStats.operations.has(operation)) {
            catStats.operations.set(operation, { calls: 0, totalTime: 0, cached: 0 });
        }
        const opStats = catStats.operations.get(operation);
        opStats.calls++;
        opStats.totalTime += elapsed;
        if (cached) opStats.cached++;

        const cacheStr = cached ? ' (CACHED)' : '';
        const timeColor = elapsed > 2000 ? '🔴' : elapsed > 500 ? '🟡' : '🟢';
        console.log(`  ${timeColor} ${category}.${operation}: ${this.formatTime(elapsed)}${cacheStr}`);

        return elapsed;
    }

    // Логування етапу
    logStage(stage, details = '') {
        const elapsed = Date.now() - this.addressStartTime;
        const detailStr = details ? ` - ${details}` : '';
        console.log(`\n📍 [${this.formatTime(elapsed)}] ${stage}${detailStr}`);
    }

    // Логування попередження
    logWarning(message) {
        console.log(`  ⚠️  ${message}`);
    }

    // Логування інформації
    logInfo(message) {
        console.log(`  ℹ️  ${message}`);
    }

    // Логування помилки
    logError(message) {
        console.log(`  ❌ ${message}`);
    }

    // Форматування часу
    formatTime(ms) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
        const mins = Math.floor(ms / 60000);
        const secs = ((ms % 60000) / 1000).toFixed(1);
        return `${mins}m ${secs}s`;
    }

    // Друк підсумків
    printSummary() {
        console.log(`\n📊 PERFORMANCE SUMMARY:`);
        console.log(`${'─'.repeat(60)}`);

        let totalCalls = 0;
        let totalTime = 0;

        for (const [category, catStats] of this.stats) {
            console.log(`\n  📁 ${category}:`);
            console.log(`     Total: ${catStats.calls} calls, ${this.formatTime(catStats.totalTime)}`);

            for (const [op, opStats] of catStats.operations) {
                const avgTime = opStats.calls > 0 ? Math.round(opStats.totalTime / opStats.calls) : 0;
                const cacheRate = opStats.calls > 0 ? Math.round((opStats.cached / opStats.calls) * 100) : 0;
                console.log(`     └─ ${op}: ${opStats.calls} calls, avg ${this.formatTime(avgTime)}, cache hit ${cacheRate}%`);
            }

            totalCalls += catStats.calls;
            totalTime += catStats.totalTime;
        }

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  📈 TOTALS: ${totalCalls} API calls, ${this.formatTime(totalTime)} cumulative time`);
    }

    // Створення таймера для вимірювання блоку коду
    createTimer(label) {
        const start = Date.now();
        return {
            stop: () => {
                const elapsed = Date.now() - start;
                console.log(`  ⏱️  ${label}: ${this.formatTime(elapsed)}`);
                return elapsed;
            }
        };
    }
}

// Singleton instance
const logger = new PerformanceLogger();

module.exports = { logger, PerformanceLogger };
