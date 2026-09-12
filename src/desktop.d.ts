export {};

declare global {
  interface Window {
    mathNotesDesktop?: {
      onCommand(callback: (command: 'close-tab' | 'reopen-tab' | 'next-tab' | 'previous-tab' | 'go-to-parent') => void): () => void;
      onPrepareWorkspaceChange(callback: () => Promise<void>): () => void;
      updateShortcuts(shortcuts: { closeTab: string; reopenTab: string; nextTab: string; previousTab: string; goToParent: string }): void;
      chooseWorkspace(): Promise<boolean>;
      getWorkspacePath(): Promise<string | null>;
      showWorkspaceInFolder(): Promise<boolean>;
    };
  }
}
