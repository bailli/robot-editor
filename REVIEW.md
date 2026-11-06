# Self-review 2026-11-06: open findings

Review of 40ac011..396297c (226 commits since the last review), by five reviewers (the
native Linux wrapper with special care; formats; editor, in two parts; tools, proxy and
harness). Everything else they found is fixed, or (the room settings' validation) was
found to be handled already. Delete this file once the last entry is done.

1. **Not run yet: CI `wrapper.yml`'s new release step.** The tag is moved, the file is
   replaced with `--clobber`, and the release is created only where it is missing. The
   build is a tar that keeps its executable bit. The workflow now has setup-node and
   package.json in its paths. It runs on the next push to main: check that the
   pre-release `linux-wrapper` got the new file.
