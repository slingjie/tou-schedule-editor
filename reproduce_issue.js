
const fs = require('fs');

async function mockBackendLogic(fileContentStr) {
    let lines = fileContentStr.split('\n').filter(line => line.trim());
    const points = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(',');
        if (parts.length < 3) {
            continue;
        }

        const dateStr = parts[0]?.trim();
        const timeStr = parts[1]?.trim();
        const loadValue = parseFloat(parts[2]?.trim());

        const timestamp = `${dateStr} ${timeStr}`;

        if (isNaN(loadValue)) {
            continue;
        }

        points.push({
            timestamp: timestamp,
            load_kw: loadValue
        });
    }

    return points;
}

const csv2Col = `Timestamp,Load
2023-01-01 00:00:00,10.5
2023-01-01 00:15:00,11.2`;

const csv3Col = `Date,Time,Load
2023-01-01,00:00:00,10.5
2023-01-01,00:15:00,11.2`;

const mockXlsxGarbage = `PK\x03\x04...garbage...`;

async function runTests() {
    let output = "";

    const res1 = await mockBackendLogic(csv2Col);
    output += `2-Column CSV Points: ${res1.length}\n`;

    const res2 = await mockBackendLogic(csv3Col);
    output += `3-Column CSV Points: ${res2.length}\n`;

    const res3 = await mockBackendLogic(mockXlsxGarbage);
    output += `XLSX Garbage Points: ${res3.length}\n`;

    fs.writeFileSync('reproduce_result.txt', output);
}

runTests();
