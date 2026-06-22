/**
 * lib/settings.ts — Configuration management for the Worklog extension
 *
 * Extracted from the monolithic index.ts. Provides settings state, stage
 * mappings, and the settings overlay UI component.
 */

import { loadSettings, persistSettings, type Settings } from '../settings-config.js';

// ── Settings state ─────────────────────────────────────────────────────

/**
 * Current settings for the extension. Initialised from Pi's canonical
 * settings files on module load and updated by the /wl settings command.
 */
export let currentSettings: Settings = loadSettings();

/**
 * Update the current settings, persist to .pi/settings.json under the
 * context-hub namespace, and return the new settings object.
 */
export function updateSettings(partial: Partial<Settings>): Settings {
  currentSettings = { ...currentSettings, ...partial };
  // Persist to .pi/settings.json under context-hub namespace
  persistSettings(partial);
  return currentSettings;
}

/**
 * Reload settings from Pi settings files. Delegates to loadSettings
 * and updates the module-level currentSettings.
 */
export function reloadSettings(): void {
  currentSettings = loadSettings();
}

// ── Stage mapping ─────────────────────────────────────────────────────

/**
 * Map of shorthand stage aliases to canonical stage names.
 * Both keys and values are valid stage values for the /wl command.
 */
export const STAGE_MAP: Record<string, string> = {
  intake: 'intake_complete',
  plan: 'plan_complete',
  progress: 'in_progress',
  review: 'in_review',
  // Canonical names mapped to themselves for validation
  idea: 'idea',
  intake_complete: 'intake_complete',
  plan_complete: 'plan_complete',
  in_progress: 'in_progress',
  in_review: 'in_review',
};

export const VALID_STAGES = new Set(Object.keys(STAGE_MAP));

// ── Settings overlay (Pi TUI) ──────────────────────────────────────────

// Lazy-loaded Pi TUI components for the settings overlay.
let piContainerCtor: any = null;
let piSettingsListCtor: any = null;
let piTextCtor: any = null;
let piGetSettingsListTheme: any = null;

async function ensurePiComponents(): Promise<boolean> {
  if (piContainerCtor && piSettingsListCtor && piTextCtor && piGetSettingsListTheme) {
    return true;
  }
  try {
    const tui = await import('@earendil-works/pi-tui');
    const agent = await import('@earendil-works/pi-coding-agent');
    piContainerCtor = tui.Container;
    piSettingsListCtor = tui.SettingsList;
    piTextCtor = tui.Text;
    piGetSettingsListTheme = agent.getSettingsListTheme;
    return true;
  } catch {
    return false;
  }
}

export interface BrowseContext {
  ui: {
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    custom?: <T>(
      render: (
        tui: { requestRender: () => void },
        theme: {
          fg: (color: string, text: string) => string;
          bold: (text: string) => string;
        },
        keybindings: unknown,
        done: (value: T) => void,
      ) => {
        render: (width: number) => string[];
        invalidate: () => void;
        handleInput?: (data: string) => void;
      },
    ) => Promise<T>;
    setWidget?: (id: string, content?: string[] | ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; invalidate: () => void; handleInput?: (data: string) => void; dispose?: () => void; })) => void;
    notify: (message: string, level?: 'info' | 'warning' | 'error') => void;
    setEditorText?: (text: string) => void;
    getEditorText?: () => string;
    onTerminalInput?: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void;
    getHeight?: () => number;
    setStatus?: (key: string, text: string | undefined) => void;
    readonly theme?: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
      bold: (text: string) => string;
    };
  };
}

/**
 * Open the settings overlay for the Worklog Pi extension.
 *
 * Uses Pi's SettingsList component with browseItemCount and showIcons
 * settings. Changes are applied immediately via onChange callback and
 * persisted to .pi/settings.json under the context-hub namespace.
 */
export function openSettingsOverlay(ctx: BrowseContext): void {
  // Build items array from current settings
  const items = [
    {
      id: 'browseItemCount',
      label: 'Number of items',
      currentValue: String(currentSettings.browseItemCount),
      values: ['3', '5', '10', '15', '20'],
    },
    {
      id: 'showIcons',
      label: 'Show icons',
      currentValue: currentSettings.showIcons ? 'on' : 'off',
      values: ['on', 'off'],
    },
    {
      id: 'showActivityIndicator',
      label: 'Activity indicator',
      currentValue: currentSettings.showActivityIndicator ? 'on' : 'off',
      values: ['on', 'off'],
    },
    {
      id: 'showHelpText',
      label: 'Help text',
      currentValue: currentSettings.showHelpText ? 'on' : 'off',
      values: ['on', 'off'],
    },
  ];

  // Open the settings overlay
  ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      // Kick off async import but return a placeholder synchronously
      let ready = false;
      let component: any = null;

      ensurePiComponents().then((ok) => {
        if (!ok) {
          ctx.ui.notify('Settings overlay unavailable: Pi TUI components not found.', 'error');
          done(undefined);
          return;
        }

        const Container = piContainerCtor;
        const SettingsList = piSettingsListCtor;
        const Text = piTextCtor;
        const getSettingsListTheme = piGetSettingsListTheme;

        const container = new Container();
        container.addChild(
          new Text(theme.fg('accent', theme.bold('Worklog Settings')), 1, 1),
        );

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id: string, newValue: string) => {
            // Apply the setting immediately
            if (id === 'browseItemCount') {
              const count = parseInt(newValue, 10);
              if (!isNaN(count) && count >= 1 && count <= 50) {
                updateSettings({ browseItemCount: count });
                ctx.ui.notify(`Browse item count set to ${count}`, 'info');
              }
            } else if (id === 'showIcons') {
              const show = newValue === 'on';
              updateSettings({ showIcons: show });
              ctx.ui.notify(`Icons ${show ? 'enabled' : 'disabled'}`, 'info');
            } else if (id === 'showActivityIndicator') {
              const show = newValue === 'on';
              updateSettings({ showActivityIndicator: show });
              ctx.ui.notify(`Activity indicator ${show ? 'enabled' : 'disabled'}`, 'info');
            } else if (id === 'showHelpText') {
              const show = newValue === 'on';
              updateSettings({ showHelpText: show });
              ctx.ui.notify(`Help text ${show ? 'enabled' : 'disabled'}`, 'info');
            }
          },
          () => {
            // Close dialog
            done(undefined);
          },
          { enableSearch: false },
        );

        container.addChild(settingsList);

        component = {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
        ready = true;
        tui.requestRender();
      }).catch((err) => {
        console.error('[worklog-browse] Failed to load Pi components:', err);
        ctx.ui.notify('Failed to open settings overlay.', 'error');
        done(undefined);
      });

      return {
        render: (width: number) => {
          if (ready && component) {
            return component.render(width);
          }
          return [theme.fg('dim', 'Loading settings...')];
        },
        invalidate: () => {
          if (component) component.invalidate();
        },
        handleInput: (_data: string) => {
          if (ready && component?.handleInput) {
            component.handleInput(_data);
            tui.requestRender();
          }
        },
      };
    },
  ).catch(() => {
    // Graceful degradation if overlay fails
    ctx.ui.notify('Settings overlay requires TUI mode.', 'warning');
  });
}
