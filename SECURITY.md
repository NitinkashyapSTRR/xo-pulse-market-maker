# Security

- **Never share, paste, or commit a private key or seed phrase.** Not in issues, not in Discord, not to anyone offering help. Nobody legitimate will ask.
- The bot reads secrets only from your local `.env`. It never logs, prints, or transmits the owner key; the key is held in a closure and used only to sign locally.
- The dashboard binds to `127.0.0.1` and is read-only: no endpoint can place or cancel orders or reveal configuration.
- Use a **dedicated** wallet funded with only what you are willing to lose.
- Read the code before running it. It is short on purpose: signing lives in `src/xo/signing.ts`, everything that touches the network in `src/xo/`.
- Report a vulnerability privately via GitHub security advisories on this repo.
