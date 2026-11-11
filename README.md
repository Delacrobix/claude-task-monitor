# task-monitor

A Claude Code mod that shows what is running, for how long, and what it costs in tokens, without leaving the terminal.

## What it shows

**Tasks panel** (docked beside the conversation)

- **Foreground**: the current conversation turn (steps, context, output tokens), subagents and tool calls in progress. Each subagent shows the tool it is using right now.
- **Background**: background subagents and background shell commands.
- **Finished**: the last 8, marked done, failed or stopped, with their duration and tokens.

Clocks tick every second while something runs.

```
Foreground 2
◑ Conversation                    1m12s
  6 steps · ctx 48k · 3.1k out
◑ review auth                       41s
  Explore ⎿ Read auth.ts · 14k tok · 9 steps

Background 1
◑ Run tests                       2m03s
  bash ⎿ npm test
```

**Usage meter** (bottom right, on the hint line under the prompt)

```
tokens 1.2M↓ 34k↑  ·  5h ▰▰▱▱▱ 42%  ·  context ▰▰▰▰▱▱▱▱▱▱ 38% 76k/200k
```

Session tokens in and out, the 5-hour usage limit (on a subscription), and how full the context window is. Bars turn amber from 60% and red from 85%. On narrow terminals the meter drops detail to fit.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install task-monitor --marketplace Delacrobix/claude-task-monitor
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install task-monitor --marketplace Delacrobix/claude-task-monitor
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Delacrobix/claude-task-monitor`, then Add plugin.

## Commands

| Command | What it does |
| --- | --- |
| `/task-monitor` | Show or hide the tasks panel. Hidden stays hidden in new sessions until you run it again. |
| `/task-monitor meter` | Show or hide the usage meter. Also remembered across sessions. |

Closing the panel by hand (its close mark or `ctrl+x x`) also keeps it hidden in later sessions.

The panel opens by itself when the terminal is at least 144 columns wide; on narrower terminals, open it with `/task-monitor`.

## Notes

- A subagent's token figure is the context of its latest request plus all the output it has generated, so it may differ slightly from the number Claude Code shows on the agent's row.
- A background shell is marked finished when its completion notice reaches the conversation.
- Finished foreground tool calls are listed only if they took 3 seconds or more.

## Development

Load the mod from a working copy for one session:

```
claude --plugin-dir /path/to/claude-task-monitor
```

Run the tests and checks:

```
claude plugin test .
claude plugin validate .
```
