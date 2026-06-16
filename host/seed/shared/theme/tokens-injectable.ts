/**
 * Injectable CSS tokens for userscripts.
 *
 * This is the `:root` variables from tokens.css, without the base reset
 * (html, body, a, ::selection) that would clobber the host page. Also includes
 * the Google Fonts @import.
 *
 * Keep in sync with tokens.css — this is the userscript-safe subset.
 */

export default `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --gray-000: #ffffff;
  --gray-050: #f9f8f3;
  --gray-100: #f3f2ea;
  --gray-150: #edece3;
  --gray-200: #e5e3d9;
  --gray-250: #dbd9ce;
  --gray-300: #ceccc2;
  --gray-350: #bfbdb3;
  --gray-400: #adaba2;
  --gray-450: #99978f;
  --gray-500: #84837c;
  --gray-550: #706f69;
  --gray-600: #5b5a56;
  --gray-650: #4a4945;
  --gray-700: #3a3a37;
  --gray-750: #2d2d2b;
  --gray-800: #232321;
  --gray-850: #1c1b1a;
  --gray-900: #171615;
  --gray-950: #111110;
  --gray-1000: #000000;

  --clay: #dc7a5a;
  --clay-interactive: #bb5d3d;
  --sky: #6d9ecf;
  --olive: #7b8f60;
  --fig: #c76989;
  --heather: #cecdd8;
  --coral: #eecfd1;
  --cactus: #bfd4cd;
  --plum: #8580c0;
  --mineral: #659c8a;
  --peach: #eeccba;
  --oat: #e6ddcf;

  --bg-primary: var(--gray-050);
  --bg-secondary: var(--gray-100);
  --bg-tertiary: var(--gray-150);
  --bg-white: var(--gray-000);
  --fg-primary: var(--gray-950);
  --fg-secondary: var(--gray-700);
  --fg-tertiary: var(--gray-500);
  --fg-caption: var(--gray-500);
  --border-primary: var(--gray-400);
  --border-secondary: var(--gray-300);
  --border-tertiary: var(--gray-200);
  --accent: var(--clay);
  --accent-interactive: var(--clay-interactive);
  --error: #b83636;
  --error-light: #e26969;
  --success: var(--olive);
  --info: var(--sky);

  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace;

  --font-regular: 400;
  --font-medium: 500;
  --font-semibold: 600;
  --font-bold: 700;

  --text-body-3: 1rem;
  --text-small: 0.875rem;
  --text-caption: 0.8125rem;
  --text-micro: 0.6875rem;

  --leading-relaxed: 1.5;
  --leading-loose: 1.6;
  --tracking-wide: 0.05em;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;

  --radius-xs: 0.25rem;
  --radius-sm: 0.5rem;
  --radius-md: 0.75rem;
  --radius-full: 9999px;

  --shadow-card: 0 0 0 1px var(--border-tertiary), 0 1px 3px rgba(0, 0, 0, 0.04);

  --duration-fast: 100ms;
  --duration-normal: 150ms;
  --duration-slow: 300ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
`;
