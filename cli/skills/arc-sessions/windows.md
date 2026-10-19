# Resolve window selection

Read this when `arc windows --json` returns an empty or incomplete list, when a command refuses the window, or after a window reload or reconnection.

Without `--window` or `ARC_WINDOW`, integrated terminals select their current owning window. External shells require exactly one live window. Automatic selection requires complete discovery. Recognized integrated terminals also require conclusive terminal membership. Remote integrated terminals require explicit selection. Reload older Arc windows or select explicitly when ownership is unavailable.

After reload or reconnection, refresh discovery before a new operation. Explicitly reselect the intended folders and their current `hostId`. A stale explicit `--window` or inherited `ARC_WINDOW` still selects the old activation. Never transfer an old request ID or follow-up ownership to the new activation. Preserve uncertain outcomes under [Interpret delivery](SKILL.md#interpret-delivery) before starting new work.

An empty list with `complete: false` does not establish a permission failure. Optional `diagnostics` report only observed `ENOENT`, `EACCES`, or `EPERM`, with a `registry` or `connection` stage. An observed `EACCES` or `EPERM` requires authorized local access to window details or the local socket. Report the limitation when the current permissions deny that access. Never bypass the permission policy or assume an editor restart repairs access.
