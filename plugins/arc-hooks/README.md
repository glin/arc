# Arc snapshot hooks

This optional Claude Code plugin captures a file before its first edit in a session. It updates Arc's snapshot manifest when Claude stops.

The hooks need Node.js on the `PATH`. They write snapshots under `~/.arc/snapshots/` or `$ARC_HOME/snapshots/` when `ARC_HOME` is set. Arc still reads Claude transcripts when this plugin is absent.

Claude Code installs the hosted ZIP into its managed plugin cache and resolves scripts through `${CLAUDE_PLUGIN_ROOT}`. The installed plugin does not need Arc source on disk. Hosted installation requires published HTTPS catalog and archive assets. See [installation](../../README.md#install) for prerequisites and hook options.

For contributor testing, run `claude --plugin-dir ./plugins/arc-hooks` from the source root. This test invocation requires that source directory. Manage hosted installations with Claude's plugin update, enable, disable, and uninstall commands.
