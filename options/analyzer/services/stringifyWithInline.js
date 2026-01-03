const stringifyWithInline = (obj, inlineKeys = ['pnl'], space = 2) => {
    const START = '__INLINE__';
    const END = '__END__';

    const json = JSON.stringify(
        obj,
        (key, value) => {
            if (inlineKeys.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
                const pairs = Object.entries(value)
                    .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
                    .join(', ');
                return `${START}{ ${pairs} }${END}`;
            }
            return value;
        },
        space
    );

    return json.replace(new RegExp(`"${START}([\\s\\S]*?)${END}"`, 'g'), (_, inner) => {
        return JSON.parse(`"${inner}"`);
    });
}

module.exports = {stringifyWithInline};
