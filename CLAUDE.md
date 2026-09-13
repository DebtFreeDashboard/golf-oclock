# Golf O'Clock

Read `INSTRUCTIONS.md` before analysing, suggesting, or changing anything in this repo.

Two rules from it that are easy to get wrong and expensive to miss:

1. **Pull the live file from GitHub and read it before touching it.** Never work from memory, a summary, or an earlier copy in the conversation. The poller commits to `main` every few minutes, so any local copy older than one run is already stale.
2. **The version lives in four places.** `web/version.json`, the line-2 comment in `web/sw.js`, `CACHE_NAME` in `web/sw.js` (a separate counter — it just has to change), and `package.json`. Update all four in the same commit.

Background and design history are in `files/`. `files/build-notes.md` is the one to read first — it has the API details, the course IDs, and the reasons behind decisions that look arbitrary.

**Committing is fine — pushing is not.** Commit your work with a clear message; leave it on the local branch. Kevin reviews and pushes from GitHub Desktop. Ask before pushing.

Never commit `data/` by hand. Those files belong to the poller, which rewrites them every few minutes; a manual commit there collides with the bot and gets rebased away.

`.github/workflows/` cannot be written by remote tools. Changes there have to be made by hand — say so explicitly rather than reporting the edit as done.
