# Restarts and recovery

Every build is written to a journal (`journal.json` in the data folder) at each stage. If the app stops while a run is in progress:

1. On the next start the app reads the journal and reattaches to the run on GitHub.
2. When the run finishes, outputs are downloaded and decrypted as usual.
3. If the run cannot be found, the build is marked as interrupted and its temporary repository is deleted.

A sweeper also removes any `mac-tmp-*` or `mac-pub-*` repository older than three hours, so nothing is left behind. You can run it by hand from **Runs → Sweep leftovers** or `mac sweep`.
