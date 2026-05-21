// Chat Pane stub for Pi TUI
export class ChatPane {
  constructor(public readonly title: string = 'Chat') {}
  sendMessage(message: string): string {
    // In a real implementation this would send to agent
    return `Message sent: ${message}`;
  }
}
