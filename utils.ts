import * as XLSX from 'xlsx';
import { MONTHS, HOURS } from './constants';
import type { Schedule, DateRule, MonthlyTouPrices, PriceMap, TierId } from './types';

// Helper function to format date range string for Excel export
export const formatDateRange = (startDate: string, endDate: string): string => {
  // Input format is 'YYYY-MM-DD'
  const start = startDate.substring(5).replace('-', '/'); // 'MM/DD'
  const end = endDate.substring(5).replace('-', '/');     // 'MM/DD'
  return `${start}-${end}`;
};

// Core Excel export logic
export const exportScheduleToExcel = (
  data: { monthlySchedule: Schedule; dateRules: DateRule[]; prices?: MonthlyTouPrices },
  filename: string
): void => {
  const wb = XLSX.utils.book_new();

  // --- Monthly Schedule Sheets ---
  const monthlyHeader = ['Month', ...HOURS];
  
  const monthlyTouData = data.monthlySchedule.map((monthSchedule, index) => [
    MONTHS[index],
    ...monthSchedule.map(cell => cell.tou),
  ]);
  const monthlyTouSheet = XLSX.utils.aoa_to_sheet([monthlyHeader, ...monthlyTouData]);
  XLSX.utils.book_append_sheet(wb, monthlyTouSheet, 'Monthly TOU');
  
  const monthlyOpLogicData = data.monthlySchedule.map((monthSchedule, index) => [
    MONTHS[index],
    ...monthSchedule.map(cell => cell.op),
  ]);
  const monthlyOpLogicSheet = XLSX.utils.aoa_to_sheet([monthlyHeader, ...monthlyOpLogicData]);
  XLSX.utils.book_append_sheet(wb, monthlyOpLogicSheet, 'Monthly OpLogic');

  // --- Date Rules Sheets ---
  if (data.dateRules.length > 0) {
    const rulesHeader = ['Rule Name', 'time_range', ...HOURS];

    const rulesTouData = data.dateRules.map(rule => [
      rule.name,
      formatDateRange(rule.startDate, rule.endDate),
      ...rule.schedule.map(cell => cell.tou)
    ]);
    const rulesTouSheet = XLSX.utils.aoa_to_sheet([rulesHeader, ...rulesTouData]);
    XLSX.utils.book_append_sheet(wb, rulesTouSheet, 'Date Rules TOU');

    const rulesOpLogicData = data.dateRules.map(rule => [
      rule.name,
      formatDateRange(rule.startDate, rule.endDate),
      ...rule.schedule.map(cell => cell.op)
    ]);
    const rulesOpLogicSheet = XLSX.utils.aoa_to_sheet([rulesHeader, ...rulesOpLogicData]);
    XLSX.utils.book_append_sheet(wb, rulesOpLogicSheet, 'Date Rules OpLogic');
  }

  // --- TOU Prices Sheet ---
  // 表头：Month + 深/谷/平/峰/尖（顺序与 TierId 集一致）
  // 导出 TOU 价格表表头顺序：Month | 尖 | 峰 | 平 | 谷 | 深
  const priceHeader = ['Month', '尖', '峰', '平', '谷', '深'];
  const prices: MonthlyTouPrices | undefined = data.prices as any;
  if (prices && Array.isArray(prices) && prices.length === 12) {
    const priceData = prices.map((pm: PriceMap, index) => [
      MONTHS[index],
      pm['尖'] ?? '',
      pm['峰'] ?? '',
      pm['平'] ?? '',
      pm['谷'] ?? '',
      pm['深'] ?? '',
    ]);
    const priceSheet = XLSX.utils.aoa_to_sheet([priceHeader, ...priceData]);
    XLSX.utils.book_append_sheet(wb, priceSheet, 'TOU Prices');
  }

  // Sanitize filename
  const safeFilename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  XLSX.writeFile(wb, `${safeFilename || 'configuration'}.xlsx`);
};

// 中文：导出“月度/每日统计”到 Excel
// 参数说明：
// - monthlyAgg: 12 个月的统计数组（index 0-11 对应 1-12 月），包含两组“充/放”与 TOU 汇总
// - dailyByMonth: Map<月份索引, 当月每日明细数组>，每日明细包含 YYYY-MM-DD 与同样的列
export const exportEnergySummaryToExcel = (
  filename: string,
  monthlyAgg: Array<{
    g1c: number; g1f: number; g2c: number; g2f: number;
    tou: Record<TierId, number>;
  }>,
  dailyByMonth: Map<number, Array<{
    ymd: string;
    g1c: number; g1f: number; g2c: number; g2f: number;
    tou: Record<TierId, number>;
  }>>
) => {
  const wb = XLSX.utils.book_new();

  // 月度统计 Sheet
  const monthlyHeader = ['月份', '充(1)', '放(1)', '充(2)', '放(2)', '尖', '峰', '平', '谷', '深'];
  const monthlyRows = Array.from({ length: 12 }, (_, m) => [
    `${m + 1}月`,
    Number(monthlyAgg[m]?.g1c || 0),
    Number(monthlyAgg[m]?.g1f || 0),
    Number(monthlyAgg[m]?.g2c || 0),
    Number(monthlyAgg[m]?.g2f || 0),
    Number(monthlyAgg[m]?.tou['尖'] || 0),
    Number(monthlyAgg[m]?.tou['峰'] || 0),
    Number(monthlyAgg[m]?.tou['平'] || 0),
    Number(monthlyAgg[m]?.tou['谷'] || 0),
    Number(monthlyAgg[m]?.tou['深'] || 0),
  ]);
  const monthlySheet = XLSX.utils.aoa_to_sheet([monthlyHeader, ...monthlyRows]);
  XLSX.utils.book_append_sheet(wb, monthlySheet, '月度统计');

  // 每日统计 Sheet（跨年合并，包含月份列便于筛选）
  const dailyHeader = ['日期', '月份', '充(1)', '放(1)', '充(2)', '放(2)', '尖', '峰', '平', '谷', '深'];
  const dailyRows: any[][] = [];
  for (let m = 0; m < 12; m++) {
    const arr = dailyByMonth.get(m) || [];
    for (const d of arr) {
      dailyRows.push([
        d.ymd,
        `${m + 1}月`,
        Number(d.g1c || 0),
        Number(d.g1f || 0),
        Number(d.g2c || 0),
        Number(d.g2f || 0),
        Number(d.tou['尖'] || 0),
        Number(d.tou['峰'] || 0),
        Number(d.tou['平'] || 0),
        Number(d.tou['谷'] || 0),
        Number(d.tou['深'] || 0),
      ]);
    }
  }
  const dailySheet = XLSX.utils.aoa_to_sheet([dailyHeader, ...dailyRows]);
  XLSX.utils.book_append_sheet(wb, dailySheet, '每日统计');

  const safeFilename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  XLSX.writeFile(wb, `${safeFilename || 'energy_summary'}.xlsx`);
};


// --- Load Data Processing ---
export type LoadDataPoint = {
    timestamp: Date;
    load: number;
};

// Helper to convert Excel serial date to JS Date
const excelSerialToDate = (serial: number): Date => {
    const utc_days = Math.floor(serial - 25569);
    const utc_value = utc_days * 86400;
    const date_info = new Date(utc_value * 1000);
    const fractional_day = serial - Math.floor(serial) + 0.0000001;
    let total_seconds = Math.floor(86400 * fractional_day);
    const seconds = total_seconds % 60;
    total_seconds -= seconds;
    const hours = Math.floor(total_seconds / (60 * 60));
    const minutes = Math.floor(total_seconds / 60) % 60;
    return new Date(date_info.getFullYear(), date_info.getMonth(), date_info.getDate(), hours, minutes, seconds);
};


export const processLoadData = async (file: File): Promise<LoadDataPoint[]> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target?.result as ArrayBuffer);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const jsonData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                if (jsonData.length < 1) {
                    throw new Error("表格为空或格式不正确。");
                }

                // Dynamic header finding
                let headerRowIndex = -1;
                let header: string[] = [];
                const timestampAliases = ['timestamp', '时间戳', '日期时间'];
                const loadAliases = ['load', '负荷', '负荷kw'];

                for (let i = 0; i < Math.min(10, jsonData.length); i++) {
                    const potentialHeader = (jsonData[i] || []).map(h => String(h || '').trim().toLowerCase());
                    const hasTimestamp = potentialHeader.some(h => timestampAliases.includes(h));
                    const hasLoad = potentialHeader.some(h => loadAliases.includes(h));
                    if (hasTimestamp && hasLoad) {
                        headerRowIndex = i;
                        header = potentialHeader;
                        break;
                    }
                }

                if (headerRowIndex === -1) {
                    throw new Error(`未能在文件的前10行中找到包含 'timestamp'/'时间戳'/'日期时间' 和 'load'/'负荷'/'负荷kw' 的表头行。`);
                }

                const dataStartIndex = headerRowIndex + 1;
                const tsIndex = header.findIndex(h => timestampAliases.includes(h));
                const loadIndex = header.findIndex(h => loadAliases.includes(h));
                
                let parsedData: LoadDataPoint[] = [];
                for (let i = dataStartIndex; i < jsonData.length; i++) {
                    const row = jsonData[i];
                    if (!row || row.length === 0) continue; // Skip empty rows

                    const timestampVal = row[tsIndex];
                    const loadVal = row[loadIndex];

                    if (timestampVal === null || timestampVal === undefined) continue;

                    let timestamp: Date;
                    if (typeof timestampVal === 'number') {
                        timestamp = excelSerialToDate(timestampVal);
                    } else if (typeof timestampVal === 'string') {
                        // Handle common date string formats that might not be parsed automatically
                        const adjustedDateStr = timestampVal.replace(/-/g, '/');
                        timestamp = new Date(adjustedDateStr);
                    } else {
                        continue; // Skip invalid timestamp types
                    }
                    
                    if (isNaN(timestamp.getTime())) continue; // Skip invalid dates

                    let load: number | null = null;
                    if (loadVal !== null && loadVal !== undefined) {
                        const parsedLoad = parseFloat(String(loadVal));
                        if (!isNaN(parsedLoad)) {
                            load = parsedLoad;
                        }
                    }

                    parsedData.push({ timestamp, load: load as any });
                }

                if (parsedData.length === 0) {
                    throw new Error("在文件中未找到有效数据行。");
                }

                // 1. Sort by timestamp
                parsedData.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

                // 2. Robustly fill missing load values
                const firstValidIndex = parsedData.findIndex(p => p.load !== null && !isNaN(p.load));

                if (firstValidIndex === -1) {
                    throw new Error("文件中不包含任何有效的负荷数值。");
                }
                const firstValidLoad = parsedData[firstValidIndex].load;

                // Backfill from the first valid value
                for (let i = 0; i < firstValidIndex; i++) {
                    parsedData[i].load = firstValidLoad;
                }
                // Forward fill for the rest
                for (let i = firstValidIndex + 1; i < parsedData.length; i++) {
                    if (parsedData[i].load === null || isNaN(parsedData[i].load)) {
                        parsedData[i].load = parsedData[i-1].load;
                    }
                }

                // 3. Resample to hourly data by summing
                const hourlyData: { [key: string]: number } = {};
                for (const point of parsedData) {
                    if (point.load === null || isNaN(point.load)) continue;
                    
                    const hourKey = new Date(
                        point.timestamp.getFullYear(),
                        point.timestamp.getMonth(),
                        point.timestamp.getDate(),
                        point.timestamp.getHours(),
                        0, 0, 0
                    ).toISOString();

                    if (!hourlyData[hourKey]) {
                        hourlyData[hourKey] = 0;
                    }
                    // The data is power in kW, and each entry is for 15 minutes (0.25 hours).
                    // To get kWh for that 15-min interval, we multiply by 0.25.
                    // Then we sum these up for the hour.
                    // A simple heuristic to detect interval: check time diff between first two points
                    let intervalHours = 0.25; // Default to 15 mins
                    if (parsedData.length > 1) {
                        const diffMillis = parsedData[1].timestamp.getTime() - parsedData[0].timestamp.getTime();
                        const diffMinutes = diffMillis / (1000 * 60);
                        if (diffMinutes > 0 && diffMinutes <= 60) { // Plausible interval
                           intervalHours = diffMinutes / 60;
                        }
                    }

                    hourlyData[hourKey] += point.load * intervalHours;
                }

                const finalData = Object.keys(hourlyData)
                    .map(key => ({
                        timestamp: new Date(key),
                        load: hourlyData[key]
                    }))
                    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                
                resolve(finalData);

            } catch (err) {
                reject(err);
            }
        };

        reader.onerror = (err) => {
            reject(new Error("读取文件失败。"));
        };

        reader.readAsArrayBuffer(file);
    });
};
