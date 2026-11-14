#!/usr/bin/env node
/**
 * PreToolUse hook for Jarvis's headless runs in safe mode: tools of the user's connectors
 * (MCP servers such as mail or calendar) are allowed without asking. Connector names are not
 * known in advance, so they cannot be listed in --allowedTools. Everything else keeps going
 * through the normal permission rules.
 */
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  let name = ''
  try {
    name = String(JSON.parse(input).tool_name ?? '')
  } catch {
    name = ''
  }
  if (name.startsWith('mcp__')) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Jarvis safe mode: connectors are allowed' } }))
  }
  process.exit(0)
})
