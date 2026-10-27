import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AgentError, COLLABORATOR_MARKER, NODE_ENGINE, PRODUCT, PRODUCT_VERSION, PUBLIC_SCHEMA_VERSION, failure } from "./core.js";
import { supportsNodeVersion } from "./node-runtime.js";
import { AgentIdSchema, toolDefinitions, publicInputSchema, type ToolName } from "./agent-schema.js";
import { AgentService } from "./agent-service.js";
import { runWorker } from "./worker.js";

const USAGE = `usage: ${PRODUCT} <command>

  mcp                        serve the eight grok_* tools over MCP stdio
  <tool> [json | -]          call one tool; input is a JSON object argument, or stdin with "-"
                             tools: spawn send wait read list respond interrupt close
  schema                     print the tool names, descriptions and input schemas
  version                    print the product and contract versions

A tool call prints one JSON result on stdout and exits 0, or 1 when call_status is "error".`;
const TOOLS = new Set<string>(toolDefinitions.map(tool => tool.name));
function publicTools(): Tool[] {
  return toolDefinitions.map(({ name, description }) => ToolSchema.parse({
    name, description, inputSchema: { ...publicInputSchema(name), type: "object" },
  }));
}
function schemaDocument(): Record<string, unknown> {
  return { product: PRODUCT, version: PRODUCT_VERSION, schema_version: PUBLIC_SCHEMA_VERSION,
    tools: publicTools().map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })) };
}
function toolResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: value.call_status === "error" };
}
/** A collaborator's own Grok may load this plugin; beneath it the server offers nothing to recurse into. */
const nested = () => !!process.env[COLLABORATOR_MARKER];
async function serveMcp(): Promise<void> {
  const service = new AgentService();
  const server = new McpServer({ name: PRODUCT, version: PRODUCT_VERSION });
  if (!nested()) {
    for (const { name, description, inputSchema } of toolDefinitions) {
      server.registerTool(name, { description, inputSchema }, async (input: unknown) => toolResult(await service.invoke(name, input)));
    }
  }
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: Infinity }));
}
function usageError(message: string): never { throw new AgentError("invalid_command", message, USAGE); }
function toolInput(args: string[]): unknown {
  if (args.length > 1) usageError("A tool call takes at most one JSON argument.");
  const text = args[0] === "-" ? readFileSync(0, "utf8") : args[0] ?? "{}";
  try { return JSON.parse(text); }
  catch { throw new AgentError("invalid_input", "The tool input is not valid JSON.", `Pass one JSON object, for example: ${PRODUCT} list '{"include_closed":true}'`); }
}
async function callTool(name: ToolName, args: string[]): Promise<void> {
  if (nested()) throw new AgentError("nested_collaborator", `${PRODUCT} is not available inside a grokpair collaborator.`, "Do the work in this conversation; the calling agent owns delegation.");
  const result = await new AgentService().invoke(name, toolInput(args));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.call_status === "error") process.exitCode = 1;
}
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
async function main(): Promise<void> {
  if (!supportsNodeVersion(process.versions.node, NODE_ENGINE)) {
    throw new AgentError("unsupported_node", `This package requires Node ${NODE_ENGINE}; this process runs ${process.versions.node}.`,
      `Make supported Node ${NODE_ENGINE} available as node on the host's PATH, then start a new session. No command was dispatched.`,
      { node_version: process.versions.node, node_engine: NODE_ENGINE });
  }
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") { process.stdout.write(`${USAGE}\n`); return; }
  if (command === "mcp" && !rest.length) return serveMcp();
  if (command === "schema" && !rest.length) { print(schemaDocument()); return; }
  if (command === "version" && !rest.length) { print({ product: PRODUCT, version: PRODUCT_VERSION, schema_version: PUBLIC_SCHEMA_VERSION }); return; }
  if (command === "internal-worker" && rest.length === 2 && rest[1]?.trim()) {
    // A collaborator's Grok must not become another collaborator's worker.
    if (nested()) throw new AgentError("nested_collaborator", `${PRODUCT} workers are not started inside a grokpair collaborator.`, "The calling agent's own grokpair starts workers.");
    await runWorker(AgentIdSchema.parse(rest[0]), rest[1]); return;
  }
  const tool = command.startsWith("grok_") ? command : `grok_${command}`;
  if (TOOLS.has(tool)) return callTool(tool as ToolName, rest);
  usageError(`Unknown command or unexpected arguments: ${command}`);
}
main().catch(error => {
  const problem = failure(error);
  process.stderr.write(`${JSON.stringify({ schema_version: PUBLIC_SCHEMA_VERSION, call_status: "error", error: problem })}\n`);
  process.exitCode = error instanceof AgentError && error.code === "invalid_command" ? 2 : 1;
});
