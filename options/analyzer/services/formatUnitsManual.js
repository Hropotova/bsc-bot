const formatUnitsManual = (value, decimals = 18) => {
    let s = value.toString();

    if (s.length <= decimals) {
        s = s.padStart(decimals + 1, '0');
    }

    const intPart = s.slice(0, s.length - decimals);
    let fracPart = s.slice(s.length - decimals);

    fracPart = fracPart.replace(/0+$/, '');

    return `${intPart}${fracPart ? '.' + fracPart : ''}`;
}

module.exports = {formatUnitsManual};
