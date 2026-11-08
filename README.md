# terminal-notify

> **From the makers of [Agent Terminal](https://4nuva.dev/agent-terminal/).**
> In Agent Terminal these notifications also reach your paired phone, where you
> can open the session and reply. [Get Agent Terminal →](https://4nuva.dev/agent-terminal/)

A Claude Code plugin that raises a desktop notification through your terminal when Claude:

- finishes a turn: `Reply: Fixed the failing test. All 42 tests pass.`
- ends a turn while background agents or commands keep running: `In-progress reply: The test run is still going. I'll report when it finishes.`
- needs a permission: `Permission needed: Bash — npm run deploy`
- asks you a question: `Question: Which database should I use?`

The title names the session and its project folder (`Claude: Fix the login redirect · my-app`), so you can tell sessions apart. The session name is the one you gave it with `/rename`, or else the title Claude Code generated.

## Install

At the prompt of a Claude Code session:

```
/plugin install terminal-notify --marketplace 4nuva/claude-terminal-notify
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install terminal-notify --marketplace 4nuva/claude-terminal-notify
```

Requires [Node.js](https://nodejs.org/) 18 or later, on your `PATH` or set as the `node` option.

## Terminals

The plugin hands Claude Code a notification escape sequence through the hook's `terminalSequence` output, and picks the sequence for the terminal it detects:

| Terminal | Sequence |
| --- | --- |
| [Agent Terminal](https://4nuva.dev/agent-terminal/) (desktop and phone) | OSC 777 |
| Ghostty, Warp, urxvt, Windows Terminal | OSC 777 |
| iTerm2, WezTerm, ConEmu | OSC 9 |
| kitty | OSC 99 |
| macOS Terminal, VS Code | bell |
| anything else | OSC 9 |

Claude Code has notifications of its own, on by default in Ghostty, kitty and iTerm2. If you see two notifications, set **Notifications** to `notifications_disabled` in `/config` (the `preferredNotifChannel` setting) to keep only this plugin's.

Some terminals only show notifications while their window is in the background (Windows Terminal), and some need notifications turned on in their own settings:

- iTerm2: Profiles → Terminal → Notifications.
- Windows Terminal 1.26 or later (first shipped in Windows Terminal Preview): set `"compatibility.allowOSC777": true` in `settings.json`, in a profile or in `profiles.defaults`. Earlier versions do not show OSC 9 or OSC 777 notifications.

Inside tmux, sequences reach the outer terminal only with `allow-passthrough on`.

## Options

Set these when you install, or later in `/plugin` → terminal-notify → Configure:

| Option | Default | What it does |
| --- | --- | --- |
| `format` | `auto` | `auto`, `osc777`, `osc9`, `osc99`, `all`, `bell` or `off`. `all` sends all three sequences, for a terminal `auto` does not know; a terminal that reads more than one (Ghostty reads 9 and 777) shows more than one. |
| `details` | on | Include the session name, the start of the reply, the command or file a permission is for, and the question. Off shows only the event and the project folder. |
| `idle_reminder` | off | Notify again when the prompt has waited 60 seconds for a reply |
| `ring_bell` | off | Also ring the terminal bell with each notification, so the terminal marks the tab. Windows Terminal rings it as the profile's `bellStyle` sets; with `notification` in `bellStyle`, you get a second notification that shows only the tab title. |
| `node` | `node` | The Node.js executable the hooks run. Set a full path when Node.js is not on your `PATH`, for example `node.exe` in the folder `mise where node` prints. |

## Privacy

Nothing leaves your machine except through your terminal. Before any text goes into a notification, known key and token formats (API keys, GitHub and Slack tokens, JWTs, bearer tokens, `password=...`, credentials in URLs, long random strings) are replaced with `***`. Turn `details` off to keep session names, reply text and commands out of notifications entirely, for example when notifications show on a lock screen.

Subagents' turns do not notify; only the main session's do.

## Development

```
node --test test/notify.test.js
claude --plugin-dir .
```

## License

The code is MIT. The Agent Terminal name and logo (`.claude-plugin/icon.png`) are not covered by that licence; all rights reserved. See [LICENSE](LICENSE).

---

**[Agent Terminal](https://4nuva.dev/agent-terminal/)** is a terminal for running coding agents, on your desktop and your phone. It shows these notifications on the desktop and forwards them to your paired phone.
