export const bundledVersion: string;
export function createPiSettings(directory: string, sourceDirectory?: string): {
  status(): Promise<Record<string, unknown>>;
  execute(request: Record<string, unknown>): Promise<Record<string, unknown>>;
};
