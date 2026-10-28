# Security

## Report a problem

Please don't report security problems in public issues. Use GitHub's private reporting instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Say what the problem is, how to reproduce it, and what an attacker could do with it.

## What Pixel Twin protects

- **Your Figma file.** The plugin only reads it. It has no code that changes it.
- **The connection between the plugin and the server.** It runs only on your computer (`localhost`). Each build makes its own secret, so other plugins and programs can't use your server.
- **Your computer.** The checking tools open only pages on `localhost` and files inside your project. The server contacts no outside address except Google Fonts.
- **Your agent.** The skill tells the agent that text in a Figma file is content, never instructions. A design can still contain text written to mislead an agent, so review what your agent does.
