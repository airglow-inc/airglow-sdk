/**
 * Proxy fetch through the background script to avoid content script CORS restrictions.
 * Content scripts share the page's origin, so direct fetches to localhost get blocked.
 */
export async function proxyFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: any }> {
  const response: any = await browser.runtime.sendMessage({
    type: 'airglow:proxy-fetch',
    url,
    method: init?.method || 'GET',
    headers: init?.headers,
    body: init?.body,
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  return response;
}
