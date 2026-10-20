const INPUT_PROPERTIES = Object.freeze({
  grok_spawn: ["task", "cwd", "worktree", "sandbox", "attachments", "search", "model", "effort", "key"],
  grok_send: ["agent_id", "task", "action", "attachments", "search", "model", "effort", "prompt_id", "resume"],
  grok_wait: ["targets", "until", "timeout_ms", "view", "max_chars"],
  grok_read: ["agent_id", "cursor", "view", "prompt_id", "max_chars"],
  grok_list: ["include_closed", "key", "limit", "cursor"],
  grok_respond: ["agent_id", "request_id", "response"],
  grok_interrupt: ["agent_id", "prompt_id"],
  grok_close: ["agent_id"],
});

/** Check the complete closed public input root. */
export function assertPublicInputPropertyContract(toolName, inputSchema) {
  if (!Object.hasOwn(INPUT_PROPERTIES, toolName)) throw new Error(`Unknown public tool: ${toolName}`);
  const expected = [...INPUT_PROPERTIES[toolName]].sort();
  const observed = Object.keys(inputSchema?.properties ?? {}).sort();
  if (inputSchema?.type !== "object" || inputSchema.additionalProperties !== false
      || JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`${toolName} must expose exactly its closed input properties: ${expected.join(", ")}`);
  }
}
