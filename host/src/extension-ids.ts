// The two Airglow extension ids. Anything that allowlists the extension
// (NM manifests, daemon origin checks) must accept both.
//   - store: the Chrome Web Store listing's id (store-assigned key pair).
//   - dev:   unpacked builds; derived from the pinned manifest `key` in
//            extension/wxt.config.ts, deterministic on every machine.
export const STORE_EXTENSION_ID = 'angbnggmaccjdinfebjoibdklmckinfb';
export const DEV_EXTENSION_ID = 'comikpjjijckpjkobpkkpnnhlcpmagic';
export const EXTENSION_IDS = [STORE_EXTENSION_ID, DEV_EXTENSION_ID];
export const EXTENSION_ORIGINS = EXTENSION_IDS.map((id) => `chrome-extension://${id}`);
