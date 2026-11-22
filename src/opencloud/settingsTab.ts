import { Notice } from 'obsidian';
import type { Setting, SettingDefinitionItem } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { confirmModal } from '../ui/ConfirmModal';
import { controllerFor, withOpenCloudSettings } from './settingsGroup';

/** The parts of upstream's settings tab the OpenCloud rows use. */
export interface OpenCloudTabSurface {
  update(): void;
  renderAppPassword(setting: Setting): unknown;
  renderNotice(setting: Setting, text: string, cls?: string): unknown;
  renderReadOnly(setting: Setting, value: string, cls?: string): unknown;
}

// Called from SettingTab.getSettingDefinitions() ([opencloud-fork]): upstream's rows go in, the fork's rows come out.
export function openCloudSettingDefinitions(
  tab: OpenCloudTabSurface,
  plugin: ObsidianNextcloudsync,
  readToken: () => string | null,
  upstream: SettingDefinitionItem[],
): SettingDefinitionItem[] {
  const { controller, deps } = controllerFor(tab, () => ({
    settings: plugin.settings,
    space: plugin.ocSpace,
    readToken,
    saveSettings: () => plugin.saveSettings(),
    resetSyncState: () => resetTrackingState(plugin),
    reinitEngine: () => plugin.initSyncEngine(),
    confirm: (o) => confirmModal(plugin.app, { ...o, cancel: 'Cancel', destructive: true }),
    notify: (m, t) => { new Notice(m, t); },
    refresh: () => tab.update(),
    renderAppPassword: (s) => tab.renderAppPassword(s),
    renderNotice: (s, text, cls) => tab.renderNotice(s, text, cls),
    renderReadOnly: (s, v, cls) => tab.renderReadOnly(s, v, cls),
  }));
  return withOpenCloudSettings(upstream, controller, deps);
}

// The same state reset as upstream's "Reset vault index" (main.ts resetVaultIndex), minus its own confirmation dialog.
async function resetTrackingState(plugin: ObsidianNextcloudsync): Promise<void> {
  if (plugin.syncEngine) {
    await plugin.syncEngine.resetIndex();
    return;
  }
  const { StateDB } = await import('../data/StateDB');
  const pluginDir = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  await StateDB.resetFile(plugin.app.vault.adapter, pluginDir, plugin.settings.deviceId);
}
