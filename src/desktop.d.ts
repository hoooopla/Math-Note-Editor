export {};

declare global {
  interface Window {
    mathNotesDesktop?: {
      onCommand(callback: (command: 'close-tab' | 'reopen-tab' | 'next-tab' | 'previous-tab') => void): () => void;
      onPrepareWorkspaceChange(callback: () => Promise<void>): () => void;
    };
  }
}
