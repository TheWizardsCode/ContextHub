// Action Palette stub for Pi TUI
export type Action = {
  id: string;
  label: string;
  execute: () => void;
};

export class ActionPalette {
  private actions: Action[] = [];
  addAction(action: Action) {
    this.actions.push(action);
  }
  getActions(): Action[] {
    return this.actions;
  }
  trigger(id: string) {
    const act = this.actions.find((a) => a.id === id);
    if (act) act.execute();
  }
}
