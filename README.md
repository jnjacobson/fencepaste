# fencepaste

A Claude Code mod that puts copy buttons above the code blocks in Claude's replies, one per statement for SQL, and a second button that drops SQL straight into the right PhpStorm database console.

Handy when Claude hands you queries to run yourself, for example against a production database it has no access to.

```
sql 1/2 [ copy ] [ ▸ shop - prod replica/ro ]
SELECT COUNT(*) FROM orders WHERE created_at >= CURDATE();
```

## What it does

- **Copy buttons.** Every closed code block in Claude's replies gets a dim label row with its language and a `[ copy ]` button. After a press the button reads `copied ✓` for two seconds.
- **One button per SQL statement.** A SQL block with several statements gets a row per statement (`sql 1/3`, `sql 2/3`, …). It splits at top-level `;` and ignores those in strings, comments and `$$` bodies. Comment lines before a statement go with it. `DELIMITER` blocks and `BEGIN … END` routine bodies stay whole.
- **PhpStorm console button** (macOS). After each turn, Claude Haiku picks the PhpStorm data source each SQL block belongs to. The button, `[ ▸ <data source> ]`, appends the statement to that data source's console, copies it too, and brings PhpStorm up with the caret after the `;`. Nothing runs by itself: you press run.
- **Fragments become whole queries.** When a block holds only part of a query, such as a `WHERE` clause that replaces the one in a query further up, the console button sends the complete query Haiku builds from the reply. The copy button keeps the fragment as written.

The buttons appear in terminal sessions, for Claude's own replies.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install fencepaste --marketplace jnjacobson/fencepaste
```

Answer `y` to add the marketplace, then pick a scope.

From a shell, or when you ask Claude to install it from this repository:

```sh
claude plugin install fencepaste --marketplace jnjacobson/fencepaste
```

Add `--config phpstorm=/path/to/PhpStorm.app` to set the PhpStorm option in the same step. A session that was already running picks the mod up after `/reload-plugins`.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jnjacobson/fencepaste`, then Add plugin.

Needs a Claude Code version with mods (plugins with function hooks); built and tested on 2.1.322.

## Configuration

| Option | Default | What it is |
| --- | --- | --- |
| `phpstorm` | empty | PhpStorm's app (`/Applications/PhpStorm.app`) or its command-line launcher. Empty looks for `PhpStorm.app` in `/Applications`, then `~/Applications`. |

Change it in `/config`, or with `--config` on install.

## How the console button works

- **Data sources** come from the newest PhpStorm config folder, `~/Library/Application Support/JetBrains/PhpStorm<version>/options/dataSources.xml` (the global ones), and from the project's `.idea/dataSources.xml`, in the working directory or the nearest folder above it that has one. When a project and a global data source share a name, the project's wins. Redis sources are left out.
- **Routing.** Haiku sees the data sources' names, groups and drivers, the reply and the working directory. A reply that names an environment (local, staging, prod, …) gets that one; otherwise production. Among several production sources it prefers a read-only replica or a non-root one. When it cannot tell the service, the block gets no console button. Its picks last for the session.
- **Consoles** are PhpStorm's `consoles/db/<data source uuid>/console.sql` in the same config folder, made when missing. Each statement goes after one blank line.
- **Jumping.** PhpStorm reloads an open console from disk only once its window is active, so fencepaste opens it, waits until PhpStorm is the frontmost app, and jumps to the new line a second time.

## Privacy

To route and complete SQL, fencepaste sends Claude Haiku the reply (its first 8,000 characters), the working directory and the names, groups and drivers of your data sources, through Claude Code's own model access. It sends no connection URLs, user names or passwords.

## Development

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .   # a session with your working copy loaded
```

## License

MIT
