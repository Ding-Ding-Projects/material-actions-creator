# Run modes

## Private temporary repository

The app creates a private `mac-tmp-<id>` repository, commits the generated workflow and your source, starts the run, downloads the outputs and deletes the repository. It uses your account's private Actions minutes.

## Encrypted public builder

The app creates a public `mac-pub-<id>` repository that only ever holds ciphertext:

- Your source is packed and encrypted with AES-256-GCM before upload. The key is stored as an encrypted Actions secret for that one repository.
- The workflow decrypts inside the runner, builds, then encrypts every output before uploading it.
- The app downloads the sealed outputs and decrypts them locally. Downloads in **Runs** are already decrypted.
- The repository is deleted when the run ends, whether it passed or failed.

Public repositories run on free standard runners, so this mode does not spend private minutes. Workflow logs are public while the repository exists, so the generated workflow never prints source or outputs.

## Optional GitHub App

With `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_INSTALLATION_ID` set, the app uses one-hour installation tokens for the temporary repository instead of your sign-in.
