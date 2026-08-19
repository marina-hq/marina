import packageJson from "../package.json" with { type: "json" };

export const CLI_VERSION = packageJson.version;

export const cliRequestHeaders = (): Record<string, string> => ({
  "user-agent": `marina-cli/${CLI_VERSION}`,
  "x-marina-client": "cli",
  "x-marina-client-version": CLI_VERSION,
});
