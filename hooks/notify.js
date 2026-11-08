// terminal-notify: a Claude Code hook that raises a desktop notification
// through the terminal Claude Code runs in. It hands Claude Code an escape
// sequence in the hook's `terminalSequence` output (OSC 777, 9 or 99, or a
// bell, picked for the terminal), so no network, no dependencies and no
// writing to the TTY.
//
// Made by the team behind Agent Terminal: https://4nuva.dev/agent-terminal/
//
// It always exits 0 and prints nothing when anything goes wrong: a
// notification must never get in the way of a session.
"use strict";

const fs = require("fs");

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";

const FORMATS = ["auto", "osc777", "osc9", "osc99", "all", "bell", "off"];

// Known key and token shapes, masked before any text leaves the session:
// a notification can land on a lock screen or a paired phone.
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/gi, // credentials in a URL
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization)(\s*[=:]\s*)\S+/gi,
  /\b[A-Za-z0-9+\/_-]{40,}={0,2}/g,
];

function mask(s) {
  for (const re of SECRETS) {
    s = s.replace(re, (m, key, sep) =>
      typeof key === "string" && typeof sep === "string" ? `${key}${sep}***` : "***");
  }
  return s;
}

// One line of plain text: no control characters (C0, DEL, C1), so nothing in
// it can end the escape sequence early or start another one.
function clean(s) {
  s = String(s == null ? "" : s)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return mask(s).replace(/\s+/g, " ").trim();
}

function charLength(s) {
  return Array.from(s).length;
}

function cap(s, n) {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n - 1).join("") + "…";
}

// The reply as plain-text sentences, in order. Code blocks, tables, headings
// and rules are left out. Each line ends a sentence, so a list item does not
// run into the sentence before it.
function replySentences(text) {
  const prose = String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/`([^`]*)`/g, "$1");
  const sentences = [];
  for (const rawLine of prose.split("\n")) {
    if (/^\s*(?:\||#{1,6}\s)/.test(rawLine)) continue;
    const line = clean(rawLine
      .replace(/^\s*(?:>+\s*)?(?:(?:[-*+]|\d+[.)])\s+)?/, "")
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1"));
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    // A sentence ends at punctuation followed by a space, not at the dot in
    // a file name or a version number.
    sentences.push(...line.match(/.+?(?:[.!?]+(?=\s|$)|$)/g).map((s) => s.trim()).filter(Boolean));
  }
  return sentences;
}

// The reply's opening sentences in at most `room` characters. A sentence that
// does not fit whole is cut with "…" when it starts before `cutBefore`, and
// left out when it starts later.
function replySummary(text, room, cutBefore) {
  let summary = "";
  for (const sentence of replySentences(text)) {
    const joined = summary ? `${summary} ${sentence}` : sentence;
    if (charLength(joined) <= room) {
      summary = joined;
      continue;
    }
    const start = summary ? charLength(summary) + 1 : 0;
    return start < cutBefore ? cap(joined, room) : summary;
  }
  return summary;
}

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

// The transcript's entries, newest first, from its last 512 KB only.
function* entriesFromEnd(file) {
  const fd = fs.openSync(file, "r");
  let lines;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    lines = buf.toString("utf8").split("\n");
  } finally {
    fs.closeSync(fd);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    // The first line can start mid-entry, where the tail read began.
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry && typeof entry === "object") yield entry;
  }
}

// The last assistant text in the transcript, for Claude Code builds whose
// Stop input has no `last_assistant_message`.
function lastAssistantText(file) {
  for (const entry of entriesFromEnd(file)) {
    const m = entry.message;
    if (!(entry.type === "assistant" || (m && m.role === "assistant"))) continue;
    const c = m && m.content;
    const text = typeof c === "string" ? c
      : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join(" ") : "";
    if (replySentences(text).length) return text;
  }
  return "";
}

// The session's name: the newest `/rename` title, else the newest title
// Claude Code generated. Claude Code writes both again as the session goes
// on, which is why reading the tail is enough.
function sessionTitle(file) {
  let generated = "";
  for (const entry of entriesFromEnd(file)) {
    if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle) {
      return entry.customTitle;
    }
    if (!generated && entry.type === "ai-title" && typeof entry.aiTitle === "string") generated = entry.aiTitle;
  }
  return generated;
}

// The part of a tool call worth naming: its command, file, URL, ...
function summarize(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "file_path", "path", "url", "pattern", "query", "description", "prompt"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  for (const v of Object.values(input)) if (typeof v === "string" && v) return v;
  return "";
}

// A plugin option (`CLAUDE_PLUGIN_OPTION_<KEY>`), or the same setting as a
// plain environment variable (`TERMINAL_NOTIFY_<KEY>`) for use outside a
// plugin.
function option(env, key, fallback) {
  const k = key.toUpperCase();
  for (const name of [`CLAUDE_PLUGIN_OPTION_${k}`, `CLAUDE_PLUGIN_OPTION_${key}`, `TERMINAL_NOTIFY_${k}`]) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return fallback;
}

function flag(env, key, fallback) {
  const v = option(env, key, "");
  if (!v) return fallback;
  return !/^(0|false|no|off)$/i.test(v);
}

// Which sequence the terminal shows as a notification.
function detectFormat(env) {
  const program = String(env.TERM_PROGRAM || "").toLowerCase();
  const term = String(env.TERM || "").toLowerCase();
  // Agent Terminal shows OSC 777 with its title and body, and forwards it to
  // the phones paired with it.
  if (env.AGENT_TERMINAL_SESSION_ID) return "osc777";
  if (env.KITTY_WINDOW_ID || term === "xterm-kitty") return "osc99";
  if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR || program === "warpterminal" || term.includes("rxvt")) {
    return "osc777";
  }
  if (program === "iterm.app" || program === "wezterm" || env.ConEmuPID) return "osc9";
  // Terminals with no notification sequence: the bell at least gets a look.
  if (program === "apple_terminal" || program === "vscode") return "bell";
  if (env.WT_SESSION) return "osc777";
  return "osc9";
}

function sequence(format, title, body) {
  switch (format) {
    case "osc777":
      // `;` separates the fields, so neither part may hold one.
      return `${ESC}]777;notify;${title.replace(/;/g, ",")};${body.replace(/;/g, ",")}${BEL}`;
    case "osc9": {
      // A body that starts with a number reads as a ConEmu command (`9;4`
      // progress, ...), and Claude Code drops it.
      let text = `${title}: ${body}`;
      if (/^[\s\u180e\u200b]*[+-]?\p{Nd}/u.test(text)) text = `· ${text}`;
      return `${ESC}]9;${text}${BEL}`;
    }
    case "osc99":
      return `${ESC}]99;;${`${title}: ${body}`.replace(/;/g, ",")}${ST}`;
    case "all":
      // Every notification sequence, for a terminal the detection does not
      // know. A terminal that reads more than one shows more than one. 777
      // goes last: Agent Terminal keeps the last notice of a burst, and 777
      // is the one that carries the title.
      return ["osc9", "osc99", "osc777"].map((f) => sequence(f, title, body)).join("");
    case "bell":
      return BEL;
    default:
      return null;
  }
}

// The notification for a hook's input, or null when it raises none.
function build(p, env) {
  if (!p || typeof p !== "object") return null;
  // A subagent's hooks fire in the same session: only the main agent's
  // turns ask for the person. (`agent_type` alone is the main agent under
  // `--agent`, which should notify.)
  if (p.agent_id) return null;
  const details = flag(env, "details", true);
  const ev = p.hook_event_name;
  let body;
  if (ev === "Stop") {
    // A background task wakes Claude for another turn when it finishes, so
    // this reply is not the last one.
    const label = Array.isArray(p.background_tasks) && p.background_tasks.length ? "In-progress reply" : "Reply";
    const prefix = `${label}: `;
    const room = BODY_LIMIT - prefix.length;
    const cutBefore = CUT_SENTENCE_START_LIMIT - prefix.length;
    let summary = "";
    if (details) {
      try {
        summary = replySummary(p.last_assistant_message, room, cutBefore);
        if (!summary && p.transcript_path) summary = replySummary(lastAssistantText(p.transcript_path), room, cutBefore);
      } catch { summary = ""; }
    }
    body = summary ? prefix + summary : label;
  } else if (ev === "PermissionRequest") {
    const tool = clean(p.tool_name) || "a tool";
    const sum = details ? cap(clean(summarize(p.tool_input)), 80) : "";
    body = `Permission needed: ${tool}` + (sum ? ` — ${sum}` : "");
  } else if (ev === "PreToolUse" && p.tool_name === "AskUserQuestion") {
    const qs = p.tool_input && p.tool_input.questions;
    const q = details ? clean(Array.isArray(qs) && qs[0] ? qs[0].question : "") : "";
    body = "Question" + (q ? `: ${q}` : " waiting");
  } else if (ev === "Notification" && p.notification_type === "idle_prompt") {
    if (!flag(env, "idle_reminder", false)) return null;
    body = "Waiting for input";
  } else {
    return null;
  }
  // Both separators: a Windows path keeps its folder name on any platform.
  const folder = clean(String(p.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop());
  let name = "";
  if (details && p.transcript_path) {
    try { name = clean(sessionTitle(p.transcript_path)); } catch { name = ""; }
  }
  return { title: notificationTitle(name, folder), body: cap(clean(body), BODY_LIMIT) };
}

const AGENT_NAME = "Claude";
// A Windows toast shows two lines of title, about 47 lowercase characters
// each, and drops the rest without an ellipsis.
const TITLE_LIMIT = 80;
const SESSION_NAME_MIN_CHARS = 16;
const BODY_LIMIT = 200;
// A reply sentence that does not fit whole is cut when it starts before this
// position in the body, and left out when it starts later: the toast would
// show only a few of its words.
const CUT_SENTENCE_START_LIMIT = 160;

// `Claude: <session name> · <folder>`. The session name is cut first, so the
// folder stays readable.
function notificationTitle(name, folder) {
  const prefix = `${AGENT_NAME}: `;
  const folderLength = folder ? charLength(` · ${folder}`) : 0;
  const room = Math.max(TITLE_LIMIT - prefix.length - folderLength, SESSION_NAME_MIN_CHARS);
  const parts = [name ? cap(name, room) : "", folder].filter(Boolean);
  return parts.length ? cap(prefix + parts.join(" · "), TITLE_LIMIT) : AGENT_NAME;
}

function output(p, env) {
  let format = option(env, "format", "auto").toLowerCase();
  if (!FORMATS.includes(format)) format = "auto";
  if (format === "off") return null;
  if (format === "auto") format = detectFormat(env);
  const n = build(p, env);
  if (!n) return null;
  const seq = sequence(format, n.title, n.body);
  if (!seq) return null;
  // Ring before the notification: Agent Terminal keeps the last notice of a
  // burst, and the notification is the one that carries the text.
  const ringsBell = format !== "bell" && flag(env, "ring_bell", false);
  return { terminalSequence: (ringsBell ? BEL : "") + seq };
}

function main() {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("error", () => {});
  process.stdin.on("end", () => {
    try {
      const out = output(JSON.parse(Buffer.concat(chunks).toString("utf8")), process.env);
      // Written, then left to finish: exiting at once can cut a pipe write short.
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {
      // Nothing to show.
    }
  });
}

if (require.main === module) {
  process.on("uncaughtException", () => process.exit(0));
  process.stdout.on("error", () => {});
  process.exitCode = 0;
  main();
} else {
  module.exports = { build, clean, detectFormat, mask, output, replySummary, sequence, sessionTitle };
}
