export function acquireBrowserLock(options?: { deadlineMs?: number }): Promise<{ release(): boolean }>;
