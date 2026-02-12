
const fs = require('fs');

// Simulate the NEW backend logic from functions/api/load/analyze.js
async function mockBackendLogic(fileContentStr) {
    let lines = fileContentStr.split('\n').filter(line => line.trim());
    const points = [];

    // 跳过标题行，从第2行开始解析
    for (let i = 1; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) continue;

        // 简单的 CSV 解析（处理引号内的逗号）
        const parts = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);

        // Fallback
        const items = parts ? parts.map(s => s.replace(/^"|"$/g, '').trim()) : line.split(',').map(s => s.trim());

        if (items.length < 2) continue;

        let timestamp;
        let loadValue;

        // 尝试推断列结构
        if (items.length >= 3) {
            const col0 = items[0];
            const col1 = items[1];
            const col2 = items[2];

            const col0IsTimestamp = (col0.includes('-') || col0.includes('/')) && col0.includes(':');

            if (col0IsTimestamp && !isNaN(parseFloat(col1))) {
                timestamp = col0;
                loadValue = parseFloat(col1);
            } else {
                timestamp = `${col0} ${col1}`;
                loadValue = parseFloat(col2);
            }
        } else {
            // 2 列: Timestamp, Load
            timestamp = items[0];
            loadValue = parseFloat(items[1]);
        }

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

// Test Case 1: 2-column CSV (Timestamp, Load)
const csv2Col = `Timestamp,Load
2023-01-01 00:00:00,10.5
2023-01-01 00:15:00,11.2`;

// Test Case 2: 3-column CSV (Date, Time, Load)
const csv3Col = `Date,Time,Load
2023-01-01,00:00:00,10.5
2023-01-01,00:15:00,11.2`;

// Test Case 3: Quoted CSV
const csvQuoted = `Timestamp,Load
"2023-01-01 00:00:00","10.5"
"2023-01-01 00:15:00","11.2"`;

async function runTests() {
    let output = "";

    const res1 = await mockBackendLogic(csv2Col);
    output += `2-Column CSV Points: ${res1.length} (Expected 2)\n`;

    const res2 = await mockBackendLogic(csv3Col);
    output += `3-Column CSV Points: ${res2.length} (Expected 2)\n`;

    const res3 = await mockBackendLogic(csvQuoted);
    output += `Quoted CSV Points: ${res3.length} (Expected 2)\n`;

    console.log(output);
    fs.writeFileSync('reproduce_result_v2.txt', output);
}

runTests();
