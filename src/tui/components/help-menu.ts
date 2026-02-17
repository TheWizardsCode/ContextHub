import blessed from 'blessed';
import { theme } from '../../theme.js';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';
import { DEFAULT_SHORTCUTS, KEY_MENU_CLOSE } from '../constants.js';

export interface HelpMenuOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
  position?: {
    top?: number | string;
    left?: number | string;
    width?: number | string;
    height?: number | string;
  };
  style?: {
    border?: { fg?: string };
    fg?: string;
    bg?: string;
  };
  shortcuts?: Array<{
    category: string;
    items: Array<{
      keys: string;
      description: string;
    }>;
  }>;
}

export class HelpMenuComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private overlay: BlessedBox;
  private menu: BlessedBox;
  private closeButton: BlessedBox;
  private onClose?: () => void;

  constructor(options: HelpMenuOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    // Create overlay background
    this.overlay = this.blessedImpl.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      hidden: true,
      mouse: true,
      clickable: true,
      style: { bg: 'black', fg: theme.tui.colors.lightText },
    });

    // Create help menu box
    this.menu = this.blessedImpl.box({
      parent: this.screen,
      top: options.position?.top || 'center',
      left: options.position?.left || 'center',
      width: options.position?.width || '70%',
      height: options.position?.height || '70%',
      label: ' Help ',
      border: { type: 'line' },
      hidden: true,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      style: options.style || {
        border: { fg: 'cyan' },
      },
    });

    // Create close button
    this.closeButton = this.blessedImpl.box({
      parent: this.menu,
      top: 0,
      right: 1,
      height: 1,
      width: 3,
      content: '[x]',
      style: { fg: 'red' },
      mouse: true,
      clickable: true,
    });

    // Set default shortcuts if not provided
    const shortcuts = options.shortcuts || DEFAULT_SHORTCUTS;
    this.updateContent(shortcuts);

    // Setup event handlers
    this.setupEventHandlers();
  }

  /**
   * Lifecycle method for parity with other components.
   * Creation happens in the constructor; this enables fluent usage.
   */
  create(): this {
    return this;
  }

  // Default shortcuts are defined in src/tui/constants.ts and provided via
  // the `DEFAULT_SHORTCUTS` import. The previous local copy was removed to
  // avoid duplication and keep documentation/behavior centralized.

  private updateContent(shortcuts: HelpMenuOptions['shortcuts']) {
    if (!shortcuts) return;

    const lines: string[] = ['Keyboard shortcuts', ''];
    
    shortcuts.forEach(section => {
      lines.push(`${section.category}:`);
      section.items.forEach(item => {
        // Pad keys to align descriptions
        const keysPadded = item.keys.padEnd(25);
        lines.push(`  ${keysPadded}${item.description}`);
      });
      lines.push('');
    });

    this.menu.setContent(lines.join('\n'));
  }

  private setupEventHandlers(): void {
    // Close on overlay click
    this.overlay.on('click', () => {
      this.close();
    });

    // Close on menu click
    this.menu.on('click', () => {
      this.close();
    });

    // Close on close button click
    this.closeButton.on('click', () => {
      this.close();
    });

    // Close on escape or q
    this.menu.key(KEY_MENU_CLOSE, () => {
      this.close();
    });
  }

  /**
   * Show the help menu
   */
  show(): void {
    this.overlay.show();
    this.menu.show();
    this.overlay.setFront();
    this.menu.setFront();
    this.menu.focus();
    this.screen.render();
  }

  /**
   * Hide the help menu
   */
  hide(): void {
    this.menu.hide();
    this.overlay.hide();
    this.screen.render();
  }

  /**
   * Close the help menu (alias for hide with callback)
   */
  close(): void {
    this.hide();
    if (this.onClose) {
      this.onClose();
    }
  }

  /**
   * Set close callback
   */
  setOnClose(callback: () => void): void {
    this.onClose = callback;
  }

  /**
   * Check if menu is visible
   */
  isVisible(): boolean {
    return !this.menu.hidden;
  }

  /**
   * Focus the menu
   */
  focus(): void {
    this.menu.focus();
  }

  /**
   * Destroy the help menu component
   */
  destroy(): void {
    this.closeButton.destroy();
    this.menu.destroy();
    this.overlay.destroy();
  }
}
