# OpenCloud Sync for Obsidian

Bidirectional sync between an Obsidian vault and a **space on an [OpenCloud](https://opencloud.eu) server** — your
personal space or a project space you share with others.

This plugin is a fork of [Nextcloud Sync](https://github.com/siosig/obsidian-nextcloudsync) by Daisuke ITO. Its sync
engine — three-way merge of concurrent edits, conflict handling that never drops a side, mass-deletion safety checks,
rename detection, sync on file change — is upstream's, unchanged. What this fork replaces is the server side: it talks to
OpenCloud's own APIs (spaces, SHA-1 checksums, TUS uploads, version history) instead of Nextcloud's.

> **Status: beta.** It works end to end against OpenCloud 9.x and is covered by unit tests and a live test suite, but it
> has not had wide real-world use yet. Keep a backup of your vault.

## What's new (0.1.0-beta.1)

First release of the OpenCloud fork:

- Sign in with server URL, username and an OpenCloud **app token**; everything else is discovered.
- Choose the **space** to sync into (personal or project), optionally a folder inside it.
- Large files upload with **TUS**; version history and restore use OpenCloud's versions.

## Requirements

- Obsidian **1.13.0** or later (desktop or mobile).
- An OpenCloud server (tested with 9.2) and an account on it.
- An **app token** for that account (your account password does not work for sync). See below.
- A server certificate the device trusts. A self-signed or private-CA certificate often does not work; see
  "Server certificate not trusted" in the [FAQ](#faq).

## Getting started

1. **Get an app token.** In OpenCloud, open your account settings and create an app token if your server shows that
   page. Otherwise ask your administrator, who can create one with
   `opencloud auth-app create --user-name=<you> --expiration=8760h`. Tokens can expire; when one does, sync fails with
   HTTP 401 until you link a new one.
2. **Install the plugin.** Until it is in the community plugin browser, install it with
   [BRAT](https://github.com/TfTHacker/obsidian42-brat) from this repository, or copy `main.js`, `manifest.json` and
   `styles.css` from a release into `<vault>/.obsidian/plugins/opencloud-sync/`.
3. **Open Settings → OpenCloud Sync** and fill in the *OpenCloud* section:
   - **Server URL** — e.g. `https://cloud.example.com` (a pasted web or WebDAV address is trimmed to this);
   - **Username**;
   - **App token** — click *Link…* to store it in Obsidian's encrypted Secret Storage (never in `data.json`).
4. Press **Connect**, then pick a **Space**. Optionally enter a **Folder in space** (e.g. `Obsidian/Work`); leave it
   empty to sync into the space root.
5. Press **Sync now**. The first sync compares the whole vault with the space; after that only changes move.

Adding another device: repeat steps 2–5 with the same space (and folder). Each device keeps its own sync state.

### Changing the space or folder later

Pick another space (or edit the folder) and confirm. This device's sync tracking is reset first, so the next sync
compares the whole vault with the new target. No files are deleted locally or on the server by the switch itself.

## How it works (in brief)

- Files are found by walking the space with WebDAV `PROPFIND` (Depth 1) and compared by **SHA-1**, which OpenCloud
  computes for every file, so unchanged content is never transferred twice.
- When nothing changed on the server, one request on the space root ETag replaces the full listing.
- Uploads carry the checksum and modification time; an upload never overwrites a newer server copy (`If-Match`).
- Concurrent edits to the same note are merged; overlapping edits keep both sides with conflict markers.
- Deleting many files at once stops and asks first (mass-delete safety check).

Details for developers: [`docs/opencloud.md`](docs/opencloud.md).

## FAQ

**Server certificate not trusted (`Trust anchor for certification path not found` / `net::ERR_CERT_AUTHORITY_INVALID`) — can I use a self-signed or private-CA certificate?**

The error looks like this. On Android: `Request Failed. SSLHandshakeException java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.` On desktop: `net::ERR_CERT_AUTHORITY_INVALID`. Both mean the device running Obsidian does not trust the HTTPS certificate your OpenCloud server presents, typically because it is self-signed or issued by a private CA.

The cause is that all of the plugin's network traffic goes through Obsidian's `requestUrl`, and this API has no way to supply a CA or to skip the check. So this cannot be fixed from the plugin settings.

What works where:

- **Android:** Obsidian does not trust CA certificates that you install on the device, so in practice you need a publicly trusted certificate.
- **Desktop:** a certificate that the operating system trusts works, and a private CA works once it is in the OS trust store.
  - **Linux (other than Flatpak and Snap):** add the CA to the NSS database in `~/.pki/nssdb` with `certutil` (from `libnss3-tools`). If the database does not exist yet, create it first with `mkdir -p ~/.pki/nssdb` and `certutil -d sql:$HOME/.pki/nssdb -N --empty-password`. Then add your CA certificate (here `ca.crt`) with `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n my-ca -i ca.crt` and restart Obsidian.
  - **Windows and macOS:** the CA would go into the operating system's trust store, but this has not been tested here (not verified).
  - **Flatpak and Snap:** not verified.
- **iOS:** not verified, so whether a private CA works there is not stated.

How to fix it: use a publicly trusted certificate. Let's Encrypt with the DNS-01 challenge can issue one without exposing your server to the internet. Another way is a tunnel or VPN service that terminates TLS with a trusted certificate. A VPN alone does not fix this: the name you reach over the VPN still needs a trusted certificate. If you already use a public certificate and still see this error, check that the server (reverse proxy) sends the full certificate chain, including the intermediate certificates (with Let's Encrypt, `fullchain.pem`). Android does not fill in intermediate certificates that the server leaves out.

There is no way to turn off certificate verification, and doing so is not recommended.

An expired certificate (`net::ERR_CERT_DATE_INVALID`) or a name mismatch (`net::ERR_CERT_COMMON_NAME_INVALID`) is a different problem that this entry does not cover; the notice shows no guidance for it.

---

**Sync fails with `HTTP 409 (MKCOL)` — "a parent folder is missing on the server".**
The plugin creates the *Folder in space* (and any missing parent folders) itself, so this means the space or a parent
folder was removed while the plugin was working. Press *Connect*, check that the space is still listed, and sync again.

**Sync fails with HTTP 401.**
The username or app token is wrong, or the token expired. Create a new token and link it under *App token*.

**"The OpenCloud space … is no longer available".**
The space was deleted or disabled, or your access was removed. Press *Connect* and choose a space again. The plugin
never treats a missing space as "everything was deleted".

**Can I sync with Nextcloud or another WebDAV server?**
No. Use the original [Nextcloud Sync](https://github.com/siosig/obsidian-nextcloudsync) plugin for Nextcloud.

## Settings defaults

| Setting | Desktop | Mobile |
|---|---|---|
| Server URL / Username / App token / Space | empty | empty |
| Folder in space | empty (space root) | empty (space root) |
| Startup sync delay | 1 second (`0` = no startup sync) | 1 second |
| Sync interval | 15 min (`0` = manual only) | off (the OS suspends timers; use *Sync now*) |
| Network timeout | 30 seconds | 30 seconds |
| Network concurrency | from device RAM: 16 (8 GB+), 8 (4 GB+), 4, or 3 when unknown | usually 3 |
| Maximum file size | unlimited (`0`) | 20 MB |
| Sync on Wi-Fi only | off | on |
| Sync on file change | on | off |
| Sync config folder | off | off |
| Auto merge file types | txt, cpp, py, c, h, hpp, rs, go, ts, js, java, sh (Markdown is always merged) | same |
| Conflict strategies | merge (auto-merge types, frontmatter), latest modified (other files) | same |
| Enable logging | off | off |

Fixed: uploads above 50 MB (desktop) / 20 MB (mobile) use TUS chunks; file locking is off (`If-Match` preconditions
prevent lost updates); the debug log is `opencloud-debug_<device>.txt` in the vault root.

## Limitations

- **Creation times** are not synced: OpenCloud has no creation-time property.
- The plugin's settings search covers all rows, but the *Space* dropdown fills only after *Connect*.

## Development

```bash
pnpm install
pnpm dev           # watch build; OUTDIR=<vault>/.obsidian/plugins/opencloud-sync pnpm dev builds into a vault
pnpm test          # unit tests (upstream's suite plus the fork's)
podman-compose up -d && pnpm test:oc   # live tests against a local OpenCloud (see docs/local-opencloud.md)
```

See [`CLAUDE.md`](CLAUDE.md) and [`docs/opencloud.md`](docs/opencloud.md) for the architecture and the rules
that keep this fork mergeable with upstream.

## License

MIT, as upstream. Original work © Daisuke ITO; see [`LICENSE`](LICENSE).
