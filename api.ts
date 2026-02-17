import type { Configuration, Schedule, DateRule, MonthlyTouPrices } from './types';
import { INITIAL_APP_STATE } from './constants';
import { enqueuePush } from './cloudSyncManager';

const STORAGE_KEY = 'tou_schedule_configurations';

// Initialize with a default configuration if none exists
const initializeDefaultData = () => {
  const allConfigs = getAllConfigsFromStorage();
  if (Object.keys(allConfigs).length === 0) {
    const defaultConfig: Configuration = {
      id: `config_${Date.now()}`,
      name: 'Default Schedule',
      scheduleData: INITIAL_APP_STATE,
    };
    allConfigs[defaultConfig.id] = defaultConfig;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allConfigs));
  }
};

const getAllConfigsFromStorage = (): Record<string, Configuration> => {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  } catch (e) {
    console.error("Failed to parse configurations from localStorage", e);
    return {};
  }
};

// --- Mock API Functions ---

// Simulates fetching a list of configurations (id and name only)
export const getConfigurations = async (): Promise<{ id: string, name: string }[]> => {
  await new Promise(resolve => setTimeout(resolve, 300)); // Simulate network delay
  initializeDefaultData();
  const allConfigs = getAllConfigsFromStorage();
  const list = Object.values(allConfigs).map(({ id, name }) => ({ id, name }));
  return list;
};

// Simulates fetching the full data for a single configuration
export const getConfiguration = async (id: string): Promise<Configuration | null> => {
  await new Promise(resolve => setTimeout(resolve, 300));
  const allConfigs = getAllConfigsFromStorage();
  const config = allConfigs[id] || null;
  if (!config) return null;
  // 兼容历史配置：缺失 prices 字段时填充默认值
  if (!('prices' in config.scheduleData)) {
    const filled: Configuration = {
      ...config,
      scheduleData: {
        ...config.scheduleData,
        prices: INITIAL_APP_STATE.prices,
      },
    };
    return filled;
  }
  return config;
};

// Simulates saving (creating or updating) a configuration
export const saveConfiguration = async (
  name: string,
  scheduleData: { monthlySchedule: Schedule; dateRules: DateRule[]; prices: MonthlyTouPrices },
  id: string | null = null
): Promise<Configuration> => {
  await new Promise(resolve => setTimeout(resolve, 500));
  const allConfigs = getAllConfigsFromStorage();
  const newId = id || `config_${Date.now()}`;
  
  const newConfig: Configuration = {
    id: newId,
    name,
    scheduleData,
  };

  allConfigs[newId] = newConfig;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(allConfigs));
  enqueuePush({ type: 'tou_config', id: newId, action: 'upsert', data: { name, schedule_data: scheduleData } });
  return newConfig;
};

// Simulates deleting a configuration
export const deleteConfiguration = async (id: string): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 400));
  const allConfigs = getAllConfigsFromStorage();
  if (allConfigs[id]) {
    delete allConfigs[id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allConfigs));
    enqueuePush({ type: 'tou_config', id, action: 'delete' });
  } else {
     throw new Error('Configuration not found');
  }
};
