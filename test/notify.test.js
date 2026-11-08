"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build, detectFormat, mask, output, sequence, sessionTitle } = require("../hooks/notify.js");

const SCRIPT = path.join(__dirname, "..", "hooks", "notify.js");
const stop = { hook_event_name: "Stop", cwd: "/work/my-app", last_assistant_message: "Fixed the bug. Tests pass. More text." };

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-notify-"));
test.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
let fixtureCount = 0;
function transcriptWith(...entries) {
  const file = path.join(fixtureDir, `${++fixtureCount}.jsonl`);
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}
const generated = (aiTitle) => ({ type: "ai-title", aiTitle, sessionId: "s1" });
const renamed = (customTitle) => ({ type: "custom-title", customTitle, sessionId: "s1" });
const reply = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } };

test("Stop names the folder and the start of the reply", () => {
  assert.deepStrictEqual(build(stop, {}), {
    title: "Claude: my-app",
    body: "Task complete: Fixed the bug. Tests pass. More text.",
  });
});

const stopBody = (reply) => build({ ...stop, last_assistant_message: reply }, {}).body;
const charCount = (s) => Array.from(s).length;

test("Stop fits as many whole sentences of the reply as the body holds", () => {
  const sentences = Array(30).fill("abcdefghi.");
  assert.strictEqual(stopBody(sentences.join(" ")), "Task complete: " + sentences.slice(0, 16).join(" "));
});

test("a sentence that does not fit is cut when it starts before character 160, left out after", () => {
  const long = "word ".repeat(60).trim() + ".";
  const cut = stopBody(`Done. ${long}`);
  assert.strictEqual(charCount(cut), 200);
  assert.ok(cut.startsWith("Task complete: Done. word word") && cut.endsWith("…"), cut);
  assert.ok(stopBody(long).endsWith("…"));
  // 15 + 150 characters: the long sentence would start at character 166.
  const opening = "abcd ".repeat(30).trim() + ".";
  assert.strictEqual(stopBody(`${opening} ${long}`), `Task complete: ${opening}`);
});

test("tables, headings, rules and code stay out of the summary, and list items end sentences", () => {
  const reply = [
    "No: the title fits.",
    "",
    "| Part | Lines |",
    "| --- | --- |",
    "| Title | 2 |",
    "",
    "## Next steps",
    "",
    "- Push the branches",
    "- Fix **the** bug",
    "",
    "---",
    "```js",
    "code();",
    "```",
    "Done",
  ].join("\n");
  assert.strictEqual(stopBody(reply), "Task complete: No: the title fits. Push the branches. Fix the bug. Done.");
});

test("a dot inside a file name or a version does not end a sentence", () => {
  assert.strictEqual(stopBody("Fixed notify.js for 1.3.1. Tests pass."), "Task complete: Fixed notify.js for 1.3.1. Tests pass.");
});

test("Stop falls back to the last reply in the transcript", () => {
  const n = build({ hook_event_name: "Stop", cwd: "/work/my-app", transcript_path: transcriptWith(reply, generated("Tidy up")) }, {});
  assert.deepStrictEqual(n, { title: "Claude: Tidy up · my-app", body: "Task complete: Done." });
});

test("session title: the newest rename wins over a newer generated title", () => {
  assert.strictEqual(sessionTitle(transcriptWith(generated("Old"), renamed("Login fix"), reply, generated("Newer"))), "Login fix");
  assert.strictEqual(sessionTitle(transcriptWith(renamed("First"), renamed("Second"))), "Second");
});

test("session title: the newest generated title without a rename, empty without either", () => {
  assert.strictEqual(sessionTitle(transcriptWith(generated("First guess"), reply, generated("Better guess"))), "Better guess");
  assert.strictEqual(sessionTitle(transcriptWith(reply)), "");
});

test("the title names the session before the folder; details off or no transcript leaves it out", () => {
  const p = { ...stop, transcript_path: transcriptWith(generated("Fix the login redirect")) };
  assert.strictEqual(build(p, {}).title, "Claude: Fix the login redirect · my-app");
  assert.strictEqual(build(p, { CLAUDE_PLUGIN_OPTION_DETAILS: "false" }).title, "Claude: my-app");
  assert.strictEqual(build({ ...stop, transcript_path: path.join(fixtureDir, "missing.jsonl") }, {}).title, "Claude: my-app");
  assert.strictEqual(build({ ...stop, cwd: undefined }, {}).title, "Claude");
});

test("a long session title is cut so the folder stays whole", () => {
  const title = build({ ...stop, transcript_path: transcriptWith(generated("word ".repeat(40))) }, {}).title;
  assert.strictEqual(Array.from(title).length, 80);
  assert.ok(title.endsWith("… · my-app"), title);
});

test("subagents stay quiet, the main agent under --agent does not", () => {
  assert.strictEqual(build({ ...stop, agent_id: "a1", agent_type: "Explore" }, {}), null);
  assert.ok(build({ ...stop, agent_type: "reviewer" }, {}));
});

test("permission and question bodies", () => {
  const perm = build({ hook_event_name: "PermissionRequest", cwd: "C:\\src\\app\\", tool_name: "Bash", tool_input: { command: "npm test" } }, {});
  assert.strictEqual(perm.title, "Claude: app");
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
  assert.deepStrictEqual(JSON.parse(ok.stdout.toString()), { terminalSequence: "\x1b]777;notify;Claude: my-app;Task complete: Fixed the bug. Tests pass. More text.\x07" });
  const bad = spawnSync(process.execPath, [SCRIPT], { input: "not json" });
  assert.strictEqual(bad.status, 0);
  assert.strictEqual(bad.stdout.toString(), "");
});
