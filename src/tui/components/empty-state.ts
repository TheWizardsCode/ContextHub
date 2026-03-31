import blessed from 'blessed';
import { theme } from '../../theme.js';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';

export interface EmptyStateOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class EmptyStateComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private box: BlessedBox;

  constructor(options: EmptyStateOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    this.box = this.blessedImpl.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: 8,
      label: ' No Work Items ',
      border: { type: 'line' },
      hidden: true,
      tags: true,
      style: {
        border: { fg: 'cyan' },
        bg: 'black',
        fg: theme.tui.colors.lightText,
      },
    });

    this.box.setContent('{center}\n  {bold}No work items yet{bold}\n\n  {214-fg}Create one with:{/214-fg}\n  {cyan-fg}wl create --title Your title{/cyan-fg}\n\n  {dim}Press any key to continue{/dim}\n{/center}');
  }

  create(): this {
    return this;
  }

  show(): void {
    this.box.show();
    this.screen.render();
  }

  hide(): void {
    this.box.hide();
    this.screen.render();
  }

  destroy(): void {
    this.box.destroy();
  }
}