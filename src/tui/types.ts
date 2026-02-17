// Common types for TUI components
import type { Widgets } from 'blessed';

export interface Position {
  top?: number | string;
  left?: number | string;
  right?: number | string;
  bottom?: number | string;
  width?: number | string;
  height?: number | string;
}

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
  border?: {
    fg?: string;
    bg?: string;
    type?: 'line' | 'double' | 'round' | 'heavy' | 'light' | 'dashed';
  };
  focus?: {
    fg?: string;
    bg?: string;
    border?: {
      fg?: string;
      bg?: string;
    };
  };
}

export interface WorkItem {
  id: string;
  title: string;
  description?: string;
  status: 'open' | 'in-progress' | 'completed' | 'deleted' | 'blocked';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  stage?: string;
  parentId?: string;
  tags?: string[];
  assignee?: string;
  createdAt: Date | string;
  updatedAt?: Date | string;
  issueType?: 'bug' | 'feature' | 'task' | 'epic' | 'chore';
  effort?: string;
  risk?: string;
}

export interface VisibleNode {
  item: WorkItem;
  depth: number;
  hasChildren: boolean;
}

export interface MoveMode {
  active: boolean;
  sourceId: string;
  descendantIds: Set<string>;
}

export interface TUIState {
  expanded: Set<string>;
  showClosed: boolean;
  filter?: 'in-progress' | 'open' | 'blocked' | 'all';
  selectedId?: string;
}

export interface ServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  sessionId?: string;
}

export type BlessedScreen = Widgets.Screen;
export type BlessedBox = Widgets.BoxElement;
export type BlessedList = Widgets.ListElement;
export type BlessedTextarea = Widgets.TextareaElement;
export type BlessedText = Widgets.TextElement;
export type BlessedTextbox = Widgets.TextboxElement;

export interface BlessedFactory {
  box: (...args: any[]) => Widgets.BoxElement;
  list: (...args: any[]) => Widgets.ListElement;
  textarea: (...args: any[]) => Widgets.TextareaElement;
  text: (...args: any[]) => Widgets.TextElement;
  textbox: (...args: any[]) => Widgets.TextboxElement;
}

export interface TuiComponentLifecycle {
  create(): this;
  show(): void;
  hide(): void;
  focus(): void;
  destroy(): void;
}