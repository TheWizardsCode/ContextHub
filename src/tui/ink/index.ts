/**
 * Ink TUI module — exports the Ink-based TUI controller and components.
 *
 * Phase 1 prototype: provides a feature-equivalent UI implementation backed
 * by Ink (React for terminal) instead of Blessed.
 *
 * Enable via `wl tui --ink` (or `WL_TUI_INK=1 wl tui`).
 */

export { InkTuiController, type InkTuiOptions } from './InkTuiController.js';
export { App, type AppProps } from './App.js';
export { WorkItemList, type WorkItemListProps } from './WorkItemList.js';
export { DetailPane, type DetailPaneProps } from './DetailPane.js';
export { MetadataPane, type MetadataPaneProps } from './MetadataPane.js';
export { StatusBar, type StatusBarProps, type FocusPane } from './StatusBar.js';
export { HelpModal, type HelpModalProps } from './HelpModal.js';
export { useWorkItems } from './useWorkItems.js';
export { useToast } from './useToast.js';
