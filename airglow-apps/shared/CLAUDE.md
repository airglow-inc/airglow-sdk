# Shared Airglow app code

Use this directory only for small pieces that several apps actually share.

Good fits:
- design tokens and CSS variables used by more than one app;
- tiny TypeScript helpers with no app-specific behavior;
- shared request/response types when copying them would cause mistakes.

Bad fits:
- app-specific prompts, selectors, RPC handlers, or UI state;
- secrets, credentials, API keys, `.env` files, or connected-account data;
- generated bundles;
- broad frameworks added for one app.

Theme files:
- `theme/tokens.css` contains plain CSS custom properties.
- `theme/tailwind-theme.css` maps those tokens for Tailwind-style usage.

Generated apps should still work if they keep all styling inside `ui/globals.css`.
