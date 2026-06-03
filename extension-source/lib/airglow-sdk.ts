// Re-export of the canonical SDK so the extension build and the CLI inject
// the same code. Lets call sites inside extension-source/ use a stable path.
export * from '../../cli/lib/airglow-sdk';
