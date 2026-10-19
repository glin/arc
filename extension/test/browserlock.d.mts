export function acquireBrowserLock(options?: { deadlineMs?: number; label?: string }): Promise<{ release(): boolean }>;
