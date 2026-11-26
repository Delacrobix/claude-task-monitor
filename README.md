# task-monitor

A Claude Code mod that shows what is running, for how long, and what it costs in tokens, without leaving the terminal.

## What it shows

**Tasks panel** (docked beside the conversation)

- **Plan**: Claude's to-do list for the current work, with a progress bar (done / total) and the step in progress.
- **Foreground**: the current conversation turn (steps, context, output tokens), subagents and tool calls in progress. Each subagent shows the tool it is using right now.
- **Background**: background subagents and background shell commands.
- **Finished**: the last 8, marked done, failed or stopped, with their duration and tokens.

Clocks tick every second while something runs, and each running task shows a moving activity strip. The panel keeps your terminal's own background, with an accent rule down its left edge.

Each section title is a button: click it (or focus the panel, Tab to the title and press Enter) to fold the section down to its title line (`▸`) and again to open it (`▾`). A folded Plan keeps its progress bar. Folded sections stay folded in later sessions.

```
▾ Foreground 2
◑ Conversation                    1m12s
  6 steps · ctx 48k · 3.1k out
◑ review auth                       41s
  Explore ⎿ Read auth.ts · 14k tok · 9 steps

▾ Background 1
◑ Run tests                       2m03s
  bash ⎿ npm test

                       mem 366 MB  swap 72 MB
                 free 2.3 GB of 16.0 GB
```

At the bottom of the panel, in small dim type, is the memory the Claude Code process is using, read every 5 seconds. When part of it is swapped out, the swapped amount follows in amber. The line under it is the machine's memory still available (amber under 20%, red under 10%).

**Usage meter** (bottom right, under the prompt)

```
tokens 1.2M↓ 34k↑  ·  5h ▰▰▱▱▱ 42% ↻ 2h 14m  ·  week ▰▱▱▱▱ 18% ↻ 3d 4h  ·  context ▰▰▰▰▱▱▱▱▱▱ 38% 76k/200k
```

Session tokens in and out, the 5-hour and weekly usage limits (on a subscription) with the time left until each resets (↻), and how full the context window is. Bars turn amber from 60% and red from 85%. On narrow terminals the meter drops detail to fit.

Click the `−` at its end (or run `/task-monitor compact`) for the compact meter, and `+` to bring the full one back:

```
5h 42% ↻ 2h 14m  ·  wk 18%  ·  fb 27%  ·  ctx 38%  +
```

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
| `/task-monitor compact` | Shrink the usage meter to its percentages, or expand it again. Same as the `−` / `+` button at its end. Remembered across sessions. |
| `/task-monitor limits` | List every usage limit Claude Code reports for the session, with its raw name, percentage and reset time. |

Closing the panel by hand (its close mark or `ctrl+x x`) also keeps it hidden in later sessions.

The panel opens by itself when the terminal is at least 144 columns wide; on narrower terminals, open it with `/task-monitor`.

## Notes

- A subagent's token figure is the context of its latest request plus all the output it has generated, so it may differ slightly from the number Claude Code shows on the agent's row.
- A background shell is marked finished when its completion notice reaches the conversation.
- Finished foreground tool calls are listed only if they took 3 seconds or more.
- The per-model weekly limits (Fable, Opus, Sonnet) do not show: Claude Code passes mods only the 5-hour and weekly windows. The meter already reads the per-model ones (`seven_day_overage_included` for Fable, `seven_day_opus`, `seven_day_sonnet`) and shows them as soon as Claude Code reports them; `/task-monitor limits` lists what it reports today.
- Memory is the Claude Code process alone, not the MCP servers or shells it starts. On macOS it is the footprint Activity Monitor shows (read with `footprint`), and `swap` counts memory that is swapped out or compressed, since macOS does not tell the two apart per process. On Linux it is the resident set and `VmSwap` from `/proc`.
- `free` is what Activity Monitor would leave: physical memory less its Memory Used (app memory, wired, compressed), from `vm_stat`; on Linux, `MemAvailable`.

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
