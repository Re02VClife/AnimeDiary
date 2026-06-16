/// <reference types="vite/client" />

interface ElectronAPI {
  openFile: (options?: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
  openDir: (options?: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
  platform: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
