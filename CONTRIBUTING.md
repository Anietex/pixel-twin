# Contributing to Pixel Twin

Thank you for helping. Bug reports, ideas and pull requests are all welcome.

## Report a bug

Open an issue. Say:

1. what you asked the agent to do;
2. which tool gave the wrong result, and the reply it gave;
3. your agent, your computer (macOS, Windows or Linux) and your Node.js version.

If you can, attach a small Figma file or a screenshot that shows the problem. Don't share designs you aren't allowed to share.

## Build and test

1. Install Node.js 24 or newer.
2. Install the packages: `npm install`
3. Download the browser the tests use: `npx playwright install chromium`
4. Run the tests: `npm test`
   The tests build the plugin and the server first. Some tests start a headless browser.
5. Check the types: `npm run typecheck`

To try a change with a real agent, run `npm run build`, re-run the plugin in Figma, and restart your agent.

## Where things are

| Folder | What it holds |
|---|---|
| `packages/plugin` | The Figma plugin. It only reads the file. |
| `packages/server` | The MCP server: the tools, the checks in the browser, and the connection to the plugin |
| `packages/shared` | Types and helpers that the plugin and the server both use |
| `skill/pixel-twin` | The skill: the workflow and rules the agent follows |
| `scripts` | `npm run setup` and the secret that pairs the plugin with the server |

## Rules for changes

- **Add a test with each change.** A bug fix gets a test that fails without the fix.
- **The plugin never changes the Figma file.** A test scans the plugin's code for calls that would. Don't work around it.
- **The server contacts nothing outside your computer except Google Fonts.** A test checks the server's code for outside addresses.
- **Keep the skill and the README in step with the tools.** A test checks that both name every tool.
- **Write for people who aren't experts.** Replies, errors and docs use common words and short sentences. Explain a technical term the first time you use it.
- **Keep the plugin and the server compatible.** If you change a message between them, build both, and say in the pull request that people must re-run the plugin.

## Send a change

1. Fork the repository and create a branch.
2. Make the change, with its test.
3. Run `npm test` and `npm run typecheck`. Both must pass.
4. Open a pull request. Say what changed and why, and how you checked it.
