export class PluginTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`The Figma plugin did not answer "${method}" within ${Math.round(timeoutMs / 1000)} seconds. Check that the plugin window is still open in Figma.`);
    this.name = 'PluginTimeoutError';
  }
}

export class PluginGoneError extends Error {
  constructor() {
    super('The Figma plugin disconnected before it answered. Reopen the file in Figma and run Pixel Twin again.');
    this.name = 'PluginGoneError';
  }
}

/** The plugin ran the request and reported a problem. The message is the plugin's own. */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

export class PortInUseError extends Error {
  constructor(port: number) {
    super(`Another Pixel Twin server is already using port ${port}, probably in another coding agent session. Close that session, then try again.`);
    this.name = 'PortInUseError';
  }
}

export class NoPluginError extends Error {
  constructor(fileSlug: string) {
    const name = fileSlug.replace(/-/g, ' ');
    super(`No open Figma file has Pixel Twin running. Open "${name}" in the Figma desktop app, then run Plugins → Development → Pixel Twin.`);
    this.name = 'NoPluginError';
  }
}

export class AmbiguousFileError extends Error {
  constructor(fileNames: string[]) {
    super(`More than one Figma file is connected (${fileNames.join(', ')}). Say which file you mean.`);
    this.name = 'AmbiguousFileError';
  }
}

/** The file is open with Pixel Twin running, but the layer in the link is not in it. */
export class NodeNotFoundError extends Error {
  constructor(fileName: string, nodeId: string) {
    super(`"${fileName}" is open with Pixel Twin running, but it has no layer ${nodeId}. Check that the link points to this file.`);
    this.name = 'NodeNotFoundError';
  }
}
