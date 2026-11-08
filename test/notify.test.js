"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { build, detectFormat, mask, output, sequence } = require("../hooks/notify.js");

const SCRIPT = path.join(__dirname, "..", "hooks", "notify.js");
const stop = { hook_event_name: "Stop", cwd: "/work/my-app", last_assistant_message: "Fixed the bug. Tests pass. More text." };

test("Stop names the folder and the start of the reply", () => {
  assert.deepStrictEqual(build(stop, {}), {
    title: "Claude Code · my-app",
    body: "Task complete: Fixed the bug. Tests pass.",
  });
});

test("subagents stay quiet, the main agent under --agent does not", () => {
  assert.strictEqual(build({ ...stop, agent_id: "a1", agent_type: "Explore" }, {}), null);
  assert.ok(build({ ...stop, agent_type: "reviewer" }, {}));
});

test("permission and question bodies", () => {
  const perm = build({ hook_event_name: "PermissionRequest", cwd: "C:\\src\\app\\", tool_name: "Bash", tool_input: { command: "npm test" } }, {});
  assert.strictEqual(perm.title, "Claude Code · app");
  assert.strictEqual(perm.body, "Permission needed: Bash — npm test");
  const q = build({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which one?" }] } }, {});
  assert.strictEqual(q.body, "Question: Which one?");
  assert.strictEqual(build({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, {}), null);
});

test("details off shows the event alone", () => {
  const env = { CLAUDE_PLUGIN_OPTION_DETAILS: "false" };
  assert.strictEqual(build(stop, env).body, "Task complete");
  assert.strictEqual(build({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf x" } }, env).body, "Permission needed: Bash");
});

test("idle reminder is off unless asked for", () => {
  const idle = { hook_event_name: "Notification", notification_type: "idle_prompt" };
  assert.strictEqual(build(idle, {}), null);
  assert.strictEqual(build(idle, { CLAUDE_PLUGIN_OPTION_IDLE_REMINDER: "true" }).body, "Waiting for input");
  assert.strictEqual(build({ ...idle, notification_type: "permission_prompt" }, { CLAUDE_PLUGIN_OPTION_IDLE_REMINDER: "true" }), null);
});

test("secrets are masked", () => {
  assert.strictEqual(mask("key sk-abcdefghijkl here"), "key *** here");
  assert.strictEqual(mask("token=hunter2abc"), "token=***");
  assert.strictEqual(mask("https://user:pw@example.com/x"), "***example.com/x");
  const perm = build({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'" } }, {});
  assert.ok(!perm.body.includes("abcdefghijklmnop"));
});

test("control characters cannot break out of the sequence", () => {
  const n = build({ ...stop, last_assistant_message: "Done\x07\x1b]52;c;AAAA\x07 now\u009c." }, {});
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(n.body));
});

test("terminal detection", () => {
  assert.strictEqual(detectFormat({ AGENT_TERMINAL_SESSION_ID: "s1", WT_SESSION: "x" }), "osc777");
  assert.strictEqual(detectFormat({ KITTY_WINDOW_ID: "1" }), "osc99");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "ghostty" }), "osc777");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "WarpTerminal" }), "osc777");
  assert.strictEqual(detectFormat({ TERM: "rxvt-unicode-256color" }), "osc777");
  assert.strictEqual(detectFormat({ WT_SESSION: "x" }), "osc777");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "iTerm.app" }), "osc9");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "WezTerm" }), "osc9");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "Apple_Terminal" }), "bell");
  assert.strictEqual(detectFormat({}), "osc9");
});

test("a terminal started from Windows Terminal inherits WT_SESSION but is detected by its TERM_PROGRAM", () => {
  assert.strictEqual(detectFormat({ WT_SESSION: "x", TERM_PROGRAM: "vscode" }), "bell");
  assert.strictEqual(detectFormat({ WT_SESSION: "x", TERM_PROGRAM: "WezTerm" }), "osc9");
});

test("sequences", () => {
  assert.strictEqual(sequence("osc777", "T;x", "a;b"), "\x1b]777;notify;T,x;a,b\x07");
  assert.strictEqual(sequence("osc9", "T", "b"), "\x1b]9;T: b\x07");
  assert.strictEqual(sequence("osc9", "4", "x"), "\x1b]9;· 4: x\x07");
  assert.strictEqual(sequence("osc9", " -1 x", "y"), "\x1b]9;·  -1 x: y\x07");
  assert.strictEqual(sequence("osc9", "\u200b4", "x"), "\x1b]9;· \u200b4: x\x07");
  assert.strictEqual(
    sequence("all", "T", "b"),
    "\x1b]9;T: b\x07" + "\x1b]99;;T: b\x1b\\" + "\x1b]777;notify;T;b\x07",
  );
  assert.strictEqual(sequence("osc99", "T", "a;b"), "\x1b]99;;T: a,b\x1b\\");
  assert.strictEqual(sequence("bell", "T", "b"), "\x07");
});

test("format option overrides detection, off and bad values", () => {
  assert.strictEqual(output(stop, { WT_SESSION: "x", CLAUDE_PLUGIN_OPTION_FORMAT: "osc9" }).terminalSequence.startsWith("\x1b]9;"), true);
  assert.strictEqual(output(stop, { CLAUDE_PLUGIN_OPTION_FORMAT: "off" }), null);
  assert.strictEqual(output(stop, { WT_SESSION: "x", CLAUDE_PLUGIN_OPTION_FORMAT: "nonsense" }).terminalSequence.startsWith("\x1b]777;"), true);
  assert.strictEqual(output(stop, { TERMINAL_NOTIFY_FORMAT: "bell" }).terminalSequence, "\x07");
});

test("ring_bell rings the bell before the notification, once with the bell format", () => {
  const env = { WT_SESSION: "x", CLAUDE_PLUGIN_OPTION_RING_BELL: "true" };
  assert.ok(output(stop, env).terminalSequence.startsWith("\x07\x1b]777;notify;"));
  assert.strictEqual(output(stop, { ...env, CLAUDE_PLUGIN_OPTION_FORMAT: "bell" }).terminalSequence, "\x07");
  assert.ok(output(stop, { WT_SESSION: "x" }).terminalSequence.startsWith("\x1b]777;notify;"));
});

test("every hook runs the node option, which defaults to node", () => {
  const manifest = require("../.claude-plugin/plugin.json");
  const { hooks } = require("../hooks/hooks.json");
  const commands = Object.values(hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.deepStrictEqual([...new Set(commands)], ["${user_config.node}"]);
  assert.strictEqual(manifest.userConfig.node.default, "node");
});

test("the script prints the hook output and exits 0, even on bad input", () => {
  const ok = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(stop), env: { WT_SESSION: "x" } });
  assert.strictEqual(ok.status, 0);
  assert.deepStrictEqual(JSON.parse(ok.stdout.toString()), { terminalSequence: "\x1b]777;notify;Claude Code · my-app;Task complete: Fixed the bug. Tests pass.\x07" });
  const bad = spawnSync(process.execPath, [SCRIPT], { input: "not json" });
  assert.strictEqual(bad.status, 0);
  assert.strictEqual(bad.stdout.toString(), "");
});
