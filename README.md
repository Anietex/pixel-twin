# Pixel Twin

Pixel Twin lets your AI coding agent build web page sections that match a Figma design exactly, then proves it. The agent reads the design, builds the section in your app, compares the result with the design in a real browser, and fixes the differences until they match.

It works with Claude Code, OpenCode, Codex, Cursor, Gemini CLI, VS Code (GitHub Copilot) and any other agent that supports MCP. It works on Figma's free Starter plan, with no monthly read limit and no Figma key.

## Why

Most Figma tools for AI agents give the agent the design and stop there. The agent never sees how close its build came. Pixel Twin closes that loop:

- **It reads the design through a Figma plugin.** Figma's web service allows only a few reads a month on the free plan. The plugin reads the file you have open, with no limit.
- **It checks the build two ways.** It compares the numbers for every layer (position, size, colour, font, spacing, corners, shadows), and it compares a picture of the build with a picture of the design. It names what each changed area is: shifted, missing line, colour, missing content and so on.
- **It checks more than the still design.** Hover, focus and pressed states, every screen width from 320 px up, animations, and accessibility and page weight.
- **It gives the agent a workflow.** A skill (an instruction file the agent follows) says what to read, what to build, when to check, and when to stop.

## How it works

Pixel Twin has three parts:

1. **A Figma plugin.** It runs in the Figma desktop app and reads the file you have open. It never changes the file.
2. **A local MCP server.** MCP (Model Context Protocol) is the standard way AI agents call outside tools. The server runs on your computer. It talks to the plugin, and it opens your built page in a headless browser (a browser with no window) to check it.
3. **A skill.** It tells the agent how to build, check and fix each section, and what to report.

Nothing leaves your computer, except font downloads from Google Fonts.

## Set up

You need:

- the Figma desktop app (any plan, including the free Starter plan);
- Node.js 24 or newer, from nodejs.org;
- one or more coding agents.

Pixel Twin is tested on macOS. Windows and Linux should work, but nobody has tested them yet.

1. Get the code:
   `git clone https://github.com/Anietex/pixel-twin.git && cd pixel-twin`
2. Run the setup:
   `npm run setup`
   It installs the packages, builds the plugin and the server, and downloads the browser that checks builds. Then it lists the coding agents it finds and asks which ones to set up.
3. Restart your coding agent, started in your project's folder.
4. In the Figma desktop app, open a design file. Choose **Plugins → Development → Import plugin from manifest**, and pick `packages/plugin/dist/manifest.json` in the Pixel Twin folder. You do this once.
5. Run **Plugins → Development → Pixel Twin**. The small window says "Connected to Pixel Twin" when your agent is running.
6. Ask your agent: "Use Pixel Twin `status`". It should list your open file.

### Setup options

| Command | What it does |
|---|---|
| `npm run setup` | Sets up everything, and asks which agents to add Pixel Twin to |
| `npm run setup -- --agents claude,cursor` | Sets up only the agents you name |
| `npm run setup -- --yes` | Sets up every agent it finds, without asking |
| `npm run setup -- --list` | Lists the agents it finds, then stops |
| `npm run setup -- --skip-build` | Changes only the agent settings |
| `npm run setup -- --remove` | Takes Pixel Twin out of the agents |

What the setup changes for each agent:

| Agent | Name for `--agents` | Server added to | Skill linked into |
|---|---|---|---|
| Claude Code | `claude` | Claude Code's user settings, with `claude mcp add` | `~/.claude/skills` |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` (or `.jsonc`), with a 10-minute tool time limit | `~/.agents/skills` |
| Codex | `codex` | `~/.codex/config.toml`, with a 10-minute tool time limit | `~/.agents/skills` |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `~/.agents/skills` |
| Gemini CLI | `gemini` | `~/.gemini/settings.json`, with a 10-minute tool time limit | `~/.agents/skills` |
| VS Code (GitHub Copilot) | `vscode` | VS Code's user `mcp.json` | `~/.agents/skills` |

The first time the setup changes a settings file, it saves the original next to it, ending in `.before-pixel-twin`. It leaves a settings file with comments alone, and prints the lines to add by hand.

The settings point to the Node.js that ran the setup. If you install a different Node.js later, run `npm run setup -- --skip-build` again.

### Set up by hand

Every agent needs the same two things: a server entry, and the skill folder `skill/pixel-twin`. In the examples, replace `/path/to/pixel-twin` with the folder you cloned.

The server is started with `node /path/to/pixel-twin/packages/server/dist/index.js`. For example:

- **Claude Code:** `claude mcp add --scope user pixel-twin -- node /path/to/pixel-twin/packages/server/dist/index.js`
- **Cursor** (`~/.cursor/mcp.json`), **Gemini CLI** (`~/.gemini/settings.json`) and most other agents:
  ```json
  { "mcpServers": { "pixel-twin": { "command": "node", "args": ["/path/to/pixel-twin/packages/server/dist/index.js"] } } }
  ```
- **OpenCode** (`~/.config/opencode/opencode.json`):
  ```json
  {
    "mcp": { "pixel-twin": { "type": "local", "command": ["node", "/path/to/pixel-twin/packages/server/dist/index.js"], "enabled": true } },
    "experimental": { "mcp_timeout": 600000 }
  }
  ```
- **Codex** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.pixel-twin]
  command = "node"
  args = ["/path/to/pixel-twin/packages/server/dist/index.js"]
  tool_timeout_sec = 600
  ```

Link the skill into the folder your agent reads skills from:

- Claude Code: `ln -s /path/to/pixel-twin/skill/pixel-twin ~/.claude/skills/pixel-twin`
- OpenCode, Codex, Cursor, Gemini CLI and VS Code: `ln -s /path/to/pixel-twin/skill/pixel-twin ~/.agents/skills/pixel-twin`

An agent that doesn't load skills still gets a short guide from the server when it connects. The guide points the agent to the skill file.

Some tools take a minute or two, such as exporting large pictures or checking a whole page. Give each tool call at least 10 minutes if your agent has a time limit.

## Use it

1. Open the Figma file in the desktop app, and run the plugin (**Plugins → Development → Pixel Twin**). You start the plugin by hand each time you open a file. Figma doesn't let plugins start themselves.
2. In your project's folder, ask your agent to build one or more sections. Either give a link to the section:
   "Build the hero and pricing sections from https://www.figma.com/design/AbC123/Landing?node-id=1-2"
   or select the sections in Figma and say:
   "Build the selected sections"
   The agent names what you selected before it starts.
3. The first time in a project, the agent asks two questions:
   - On screens narrower than the design, should the layout reflow, or should the whole design shrink to fit?
   - How much should the page move when the design has no motion: none, subtle or expressive?
   It saves your answers in `pixel-twin.json` in your project, with the address of your development server, the breakpoints and the image folder.
4. The agent reads the design, builds the sections in your app's own framework (or React for a new project), checks them and fixes the differences. For two or more sections, it first sets up the shared colours, fonts and spacing. Then it builds one section at a time, each with its own sub-agent (a helper agent with a fresh context), where your agent supports them.
5. Read the agent's report. It lists:
   - the sections built and the files changed;
   - the widths checked;
   - anything it couldn't match, and why;
   - the phone, tablet and motion choices it made;
   - the quality findings for you to decide on;
   - the results of your project's lint, type check, tests and build;
   - what it cleaned up.
   Watch the video it recorded to judge the motion.

The agent matches the design exactly unless you ask for a change.

The agent keeps its working files (pictures, saved replies, its own screenshots and scripts) in `.pixel-twin/` in your project, and deletes them when it finishes. It keeps the videos and a small memory of each section's checks. Pixel Twin also deletes working files older than a day each time it starts.

While it builds several sections, the agent keeps a plan in `.pixel-twin/plan.md`: the shared files, the shared components, and what each section has built. If a session stops part-way, ask a new session to carry on from the plan.

### Files you can only view

Figma runs plugins only in files you can edit. If you can only view a design, make a copy in your drafts (Figma's **Duplicate** command), and run the plugin in the copy. The copy doesn't change when the designer changes the original, so make a new copy to pick up their changes.

### Several agents at once

Several agent sessions can use Pixel Twin at the same time, in one agent or in different ones. The first session holds the connection to Figma, and the others share it. When the first one closes, another takes over within a few seconds, and the plugin reconnects by itself.

### Token use

Each step an agent takes re-reads everything its session has seen so far, so a long session costs more with every step. Pixel Twin keeps sessions short in two ways:

- Its replies are short. A whole page is sent as a list of its sections to read one at a time, not as one large reply.
- For two or more sections, the agent gives each section to its own sub-agent, one at a time. Each sub-agent starts with a fresh context, and the main agent reads only its short report. Claude Code and OpenCode support sub-agents.

To keep the cost down further:

1. With an agent that has no sub-agents, build two or three sections per session, then start a new session for the next ones. Pixel Twin remembers each section's checks between sessions.
2. Use a lower thinking effort, or a smaller model, when the work is mostly fixing small differences.

## The tools

| Tool | What it does |
|---|---|
| `status` | Lists the Figma files with the plugin running, what is selected in each, and the project settings |
| `get_outline` | Lists the layers of a page or frame |
| `get_selection` | Lists the layers you have selected in Figma, with a link to each |
| `get_section` | Reads one section: every layer, the layout hints, the motion the designer set, and guesses of motion the design implies |
| `get_screenshot` | Saves a picture of the design |
| `export_assets` | Saves the images (photos as WebP at no more than twice their shown size, with smaller sizes for phones) and SVG icons, one per file, with a list of every file |
| `get_fonts` | Finds the font files, and can download Google fonts |
| `find_mobile_version` | Finds the mobile design of a section, if there is one, also on pages named Mobile |
| `compare` | Checks a built section against the design, number by number and picture by picture, also in its hover, focus or pressed state. Names what each changed area is and which layers it touches, and finds frame lines hidden under children |
| `compare_page` | Runs `compare` on every section of a page |
| `check_responsive` | Checks every width from 320 px up: sideways scrolling, overlaps, centring, small text, tap sizes and picture shapes |
| `check_motion` | Checks the page's animations: smoothness, "reduce motion", layout jumps and the designer's timings |
| `record` | Records a short video of the page moving |
| `check_quality` | Reports text contrast, alt text, headings, image weight and loading, unsafe links, scripts in SVGs, font loading, and script and style size |
| `clean_up` | Deletes Pixel Twin's working files when the work is done: pictures, saved replies and the agent's own scratch files. Keeps the videos and the memory of each section's checks |

## Security and privacy

- **The plugin only reads.** It never changes your Figma file. A test checks the plugin's code for any call that could change it.
- **Everything stays on your computer.** The plugin talks only to the server on your computer (`localhost`). The only outside address Pixel Twin contacts is Google Fonts, when you ask it to download a font.
- **Only your plugin can talk to your server.** The build creates a secret in `.pixel-twin-secret` and puts it in both the plugin and the server. The connection is refused without it. The secret is never committed.
- **The browser opens only your own pages.** The checking tools open only addresses on `localhost` and files inside your project.
- **Designs are data.** The skill tells the agent that text and layer names in a Figma file are content, never instructions.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Limits

- You need the Figma desktop app open, with the plugin running, while the agent reads the design.
- The plugin doesn't run in Figma's Dev Mode yet.
- Browsers and Figma draw some things differently, such as some letter pairs ("fi", "fl") and blurs. `compare` lists these as known limits rather than failures.
- It builds web pages. It doesn't build iOS or Android apps.

## If something goes wrong

- **The plugin window says "Waiting for Pixel Twin server…".** Your coding agent isn't running, or Pixel Twin isn't added to it. Start the agent in your project's folder. If that doesn't help, run `npm run setup -- --list` and set up the agent.
- **A tool says "Port 3851 is in use, but not by a Pixel Twin session that can share it".** An older Pixel Twin build, or another program, holds the port. Restart your other agent sessions (or close the program). Pixel Twin tries again every 3 seconds and connects by itself.
- **A tool says "No open Figma file has Pixel Twin running".** Open the file in the Figma desktop app and run the plugin.
- **A tool says "Could not start the headless browser".** Run `npx playwright install chromium` in the Pixel Twin folder.
- **A tool says the plugin is an older build, or `get_section` says "Motion was not read".** Close the Pixel Twin window in Figma and run the plugin again.
- **The plugin connects, then drops every 2 seconds.** The plugin and the server were built at different times. Run `npm run build`, re-run the plugin, and restart your agent.
- **A tool call stops after 60 seconds.** Your agent's tool time limit is too short. Run the setup for that agent again, or raise the limit by hand (see "Set up by hand").

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send a change.

## Licence

MIT. See [LICENSE](LICENSE).
