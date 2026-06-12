export const BROWSER_TOOL_APPROVALS_KEY = '__airglow_browser_tool_approvals';
export const BROWSER_TOOL_APPROVAL_TIMEOUT_MS = 120_000;

export type BrowserToolApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired';

export interface BrowserToolApprovalRequest {
  id: string;
  message: string;
  status: BrowserToolApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
}

export function normalizeBrowserToolApprovals(value: unknown): BrowserToolApprovalRequest[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): BrowserToolApprovalRequest | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      const message = typeof record.message === 'string' ? record.message : '';
      const status = record.status === 'approved' || record.status === 'declined' || record.status === 'expired'
        ? record.status
        : 'pending';
      const requestedAt = typeof record.requestedAt === 'string' ? record.requestedAt : '';
      const resolvedAt = typeof record.resolvedAt === 'string' ? record.resolvedAt : '';
      if (!id || !message || !requestedAt) return null;
      return {
        id,
        message,
        status,
        requestedAt,
        ...(resolvedAt ? { resolvedAt } : {}),
      };
    })
    .filter((item): item is BrowserToolApprovalRequest => Boolean(item))
    .slice(-20);
}

export function latestPendingBrowserToolApproval(
  approvals: BrowserToolApprovalRequest[],
): BrowserToolApprovalRequest | null {
  return [...approvals].reverse().find((approval) => approval.status === 'pending') || null;
}
