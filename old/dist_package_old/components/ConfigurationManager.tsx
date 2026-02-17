import React from 'react';

interface ConfigurationManagerProps {
  configurations: { id: string; name: string }[];
  currentConfigId: string | null;
  configName: string;
  onNameChange: (newName: string) => void;
  isDirty: boolean;
  isLoading: boolean;
  isSaving: boolean;
  isExporting: boolean;
  isImporting: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
  onDelete: () => void;
  onImportClick: () => void;
}

export const ConfigurationManager: React.FC<ConfigurationManagerProps> = ({
  configurations,
  currentConfigId,
  configName,
  onNameChange,
  isDirty,
  isLoading,
  isSaving,
  isExporting,
  isImporting,
  onSelect,
  onNew,
  onSave,
  onSaveAs,
  onExport,
  onDelete,
  onImportClick,
}) => {
  const buttonBaseClasses = "px-4 py-2 rounded-md font-semibold text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed";

  const isAnyActionInProgress = isLoading || isSaving || isExporting || isImporting;

  return (
    <div className="p-4 bg-white rounded-xl shadow-lg mb-6">
      <h2 className="text-xl font-bold text-slate-800 mb-4">Configuration Manager</h2>
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
          <div>
            <label htmlFor="config-select" className="block text-sm font-medium text-slate-700">
              Load Configuration
            </label>
            <select
              id="config-select"
              value={currentConfigId || ''}
              onChange={(e) => onSelect(e.target.value)}
              disabled={isAnyActionInProgress || configurations.length === 0}
              className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm shadow-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
            >
              <option value="" disabled>
                {configurations.length === 0 ? 'No configurations saved' : 'Select a configuration...'}
              </option>
              {configurations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="config-name" className="block text-sm font-medium text-slate-700">
              Configuration Name {isDirty && <span className="text-red-500 font-bold">*</span>}
            </label>
            <input
              id="config-name"
              type="text"
              value={configName}
              onChange={(e) => onNameChange(e.target.value)}
              disabled={isAnyActionInProgress}
              className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm shadow-sm placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
              placeholder="Enter configuration name"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
          <button onClick={onNew} disabled={isAnyActionInProgress} className={`${buttonBaseClasses} bg-slate-200 text-slate-800 hover:bg-slate-300`}>
            New
          </button>
          <button onClick={onImportClick} disabled={isAnyActionInProgress} className={`${buttonBaseClasses} bg-purple-600 text-white hover:bg-purple-700`}>
             {isImporting ? 'Importing...' : 'Import'}
          </button>
          <button onClick={onSave} disabled={isAnyActionInProgress || !isDirty} className={`${buttonBaseClasses} bg-blue-600 text-white hover:bg-blue-700`}>
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={onSaveAs} disabled={isAnyActionInProgress} className={`${buttonBaseClasses} bg-green-600 text-white hover:bg-green-700`}>
            Save As...
          </button>
          <button onClick={onExport} disabled={isAnyActionInProgress} className={`${buttonBaseClasses} bg-teal-600 text-white hover:bg-teal-700`}>
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
          <button onClick={onDelete} disabled={isAnyActionInProgress || !currentConfigId} className={`${buttonBaseClasses} bg-red-600 text-white hover:bg-red-700`}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};