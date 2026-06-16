// Re-export of the canonical SDK so the extension build and the host daemon inject
// the same code. Lets call sites inside extension/ use a stable path.
export * from '../../sdk/airglow-sdk';
