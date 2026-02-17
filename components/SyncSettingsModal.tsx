import React, { useState, useEffect } from 'react';
import { pullFromCloud } from '../cloudSyncManager';


interface SyncSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const STORAGE_KEY = 'SYNC_API_KEY';

export const SyncSettingsModal: React.FC<SyncSettingsModalProps> = ({ isOpen, onClose }) => {
    const [apiKey, setApiKey] = useState('');
    const [isVisible, setIsVisible] = useState(false);
    const [status, setStatus] = useState<'idle' | 'saved'>('idle');

    // Load key from localStorage when modal opens
    useEffect(() => {
        if (isOpen) {
            const storedKey = localStorage.getItem(STORAGE_KEY) || '';
            setApiKey(storedKey);
            setStatus('idle');
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSave = () => {
        if (apiKey.trim()) {
            localStorage.setItem(STORAGE_KEY, apiKey.trim());
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
        setStatus('saved');

        // Trigger immediate pull to fetch data
        if (apiKey.trim()) {
            // force pull
            pullFromCloud().catch(err => console.error('Immediate sync failed:', err));
        }

        setTimeout(() => {
            onClose();
        }, 500);
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
                <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                    <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                        🔐 Cloud Sync Settings
                    </h3>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-600 transition-colors"
                    >
                        ✕
                    </button>
                </div>

                <div className="p-6 space-y-4">
                    <p className="text-sm text-slate-600">
                        Enter your <strong>Sync API Key</strong> to enable cloud synchronization features.
                        This key is stored only in your browser's local storage.
                    </p>

                    <div className="space-y-2">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">
                            API Key
                        </label>
                        <div className="relative">
                            <input
                                type={isVisible ? "text" : "password"}
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="Enter your secret key..."
                                className="w-full px-4 py-2 pr-12 border border-slate-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-mono text-sm"
                            />
                            <button
                                type="button"
                                onClick={() => setIsVisible(!isVisible)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-sm"
                            >
                                {isVisible ? "Hide" : "Show"}
                            </button>
                        </div>
                    </div>

                    {status === 'saved' && (
                        <div className="text-sm text-green-600 font-medium flex items-center gap-1 animate-in fade-in slide-in-from-top-1">
                            ✓ Saved successfully
                        </div>
                    )}
                </div>

                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-md transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md shadow-sm transition-colors focus:ring-2 focus:ring-offset-1 focus:ring-blue-500"
                    >
                        Save Key
                    </button>
                </div>
            </div>
        </div>
    );
};
