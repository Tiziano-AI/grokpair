// The one owner of grokpair's host packaging. `pnpm build` writes every file
// returned here and `pnpm validate` fails when a committed copy drifts, so each
// host format is derived from package.json and these presentation choices
// rather than edited by hand.

const PRODUCT = "grokpair";
const REPOSITORY = "https://github.com/Tiziano-AI/grokpair";
const AUTHOR = { name: "Tiziano AI", url: "https://github.com/Tiziano-AI" };

/**
 * Variables forwarded to the server by Codex, which starts stdio servers with a minimal environment:
 * where Grok, its configuration and its credentials are, and the homes grokpair protects. Grok's own
 * settings belong in its configuration, which every host reads alike.
 */
export const FORWARDED_ENVIRONMENT = [
  "GROK_HOME", "GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_SANDBOX", "XAI_API_KEY",
  "GROKPAIR_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR",
];
/** Covers the longest public wait (600 s) with a transport margin. */
export const TOOL_TIMEOUT_SECONDS = 660;
/** Claude Code prefixes plugin MCP tools with the plugin and server names. */
export const CLAUDE_TOOL_PREFIX = `mcp__plugin_${PRODUCT}_${PRODUCT}__`;

export function generatedFiles(pkg) {
  const description = pkg.description;
  const common = {
    name: PRODUCT, version: pkg.version, description, author: AUTHOR,
    homepage: REPOSITORY, repository: REPOSITORY, license: pkg.license, keywords: pkg.keywords,
  };
  const codexPlugin = {
    ...common,
    skills: "./skills/",
    mcpServers: {
      [PRODUCT]: {
        command: `./bin/${PRODUCT}`, args: ["mcp"], cwd: ".", env_vars: FORWARDED_ENVIRONMENT,
        startup_timeout_sec: 30, tool_timeout_sec: TOOL_TIMEOUT_SECONDS,
      },
    },
    interface: {
      displayName: PRODUCT,
      shortDescription: "Grok as a detached collaborator while you work.",
      longDescription: "Hand a detached Grok Build collaborator a complete brief (research, a review, an implementation in its own worktree, a document or media) and keep working. Wait for its result, read what Grok said and made, continue the same conversation, answer its questions, redirect or close it. You keep acceptance, integration and every claim.",
      developerName: AUTHOR.name,
      category: "Productivity",
      capabilities: ["Interactive", "Read", "Write"],
      websiteURL: REPOSITORY,
      privacyPolicyURL: `${REPOSITORY}/blob/main/PRIVACY.md`,
      termsOfServiceURL: `${REPOSITORY}/blob/main/TERMS.md`,
      defaultPrompt: [
        "Ask Grok to review this change read-only while I keep working, then read its findings.",
        "Have Grok research this question with sources; wait for its result and check the key claims.",
        "Give Grok a worktree to draft an alternative implementation, then inspect its diff.",
      ],
      brandColor: "#111827",
    },
  };
  const claudePlugin = {
    ...common,
    mcpServers: {
      [PRODUCT]: { command: `\${CLAUDE_PLUGIN_ROOT}/bin/${PRODUCT}`, args: ["mcp"], timeout: TOOL_TIMEOUT_SECONDS * 1000 },
    },
  };
  const codexMarketplace = {
    name: PRODUCT,
    interface: { displayName: PRODUCT },
    plugins: [{
      name: PRODUCT, source: { source: "local", path: "./plugin" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity",
    }],
  };
  const claudeMarketplace = {
    name: PRODUCT,
    owner: { name: AUTHOR.name },
    metadata: { description },
    plugins: [{ name: PRODUCT, source: "./plugin", description, category: "productivity", homepage: REPOSITORY }],
  };
  return {
    "plugin/.codex-plugin/plugin.json": codexPlugin,
    "plugin/.claude-plugin/plugin.json": claudePlugin,
    "plugin/package.json": { name: PRODUCT, version: pkg.version, private: true, type: "module" },
    ".agents/plugins/marketplace.json": codexMarketplace,
    ".claude-plugin/marketplace.json": claudeMarketplace,
  };
}

export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
