### Airglow installation instructions (for AI Agent)

#### Install dependencies and start dev server
- Say to user that you are starting the installation, which should take few minutes.
- Read `airglow-sdk/README.md`, `airglow-sdk/airglow-apps/AGENTS.md`
- **Install dependencies, start dev server:** open `airglow-sdk/airglow-apps`, run `pnpm install` and `pnpm airglow dev`.
 - If computer is missing `pnpm` or some necessary dev tool like node, install it.

#### Install extension
1) Send instructions link <https://airglow.dev/#install>
2) Give the user full path to `airglow-sdk/extension` folder, say this is the path to use for "Load unpacked" button.
3) Ask user to report back when they're done. Stop and wait for their response.

#### Suggest an app
Once done, provide user with two options:
   1. Create a new app. Ask user to say which website to change and which feature to modify.
   2. Modify existing app. List app names from `airglow-apps/` to user.

**RULES:**
- Autonomously fix technical issues during installation, don't do destructive actions.
- **Be brief and use plain language**
