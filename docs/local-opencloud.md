# Local OpenCloud server for development

`compose.yml` in the repository root starts a throwaway OpenCloud instance for manual testing of the
plugin. It is meant for development only: fixed credentials, self-signed TLS, basic auth enabled.

## Start and stop

```bash
podman-compose up -d        # rootless Podman; first start generates the config (~5–10 s)
podman-compose logs -f      # follow the server log
podman-compose down         # stop, keep config and data
podman-compose down -v      # stop and wipe config and data (fresh instance on next start)
```

## Endpoints and credentials

| What | Value |
|---|---|
| Web UI | https://localhost:8080 |
| WebDAV root (plugin server URL) | `https://localhost:8080/remote.php/dav/files/admin/` |
| Username | `admin` |
| Password | `admin` |

The port is bound to `127.0.0.1` only.

Quick check from a shell (`-k` because the certificate is self-signed):

```bash
curl -k -u admin:admin -X PROPFIND -H 'Depth: 1' https://localhost:8080/remote.php/dav/files/admin/
```

## Things to know

- **HTTPS only, self-signed.** OpenCloud's built-in IDP refuses to start unless `OC_URL` is `https://`,
  so the server terminates TLS itself with a generated certificate. The plugin, the browser and `curl`
  must accept that certificate (the plugin's untrusted-certificate handling lives in `src/network/certTrust.ts`).
- **Basic auth is enabled** (`PROXY_ENABLE_BASIC_AUTH=true`); OpenCloud disables it by default, which makes
  username/password WebDAV requests return 401.
- **Port 8080 is set in three places** — `ports`, `PROXY_HTTP_ADDR` and `OC_URL`. Change all three together,
  or login ends in `/access-denied`.
- **Init runs once.** The first start writes `/etc/opencloud/opencloud.yaml` into the `opencloud-config`
  volume; later starts reuse it. Changing `IDM_ADMIN_PASSWORD` after that has no effect until `down -v`.
- **Rootless Podman:** named volumes are used instead of bind mounts so ownership matches the image's
  uid 1000 without extra `userns` settings.
- This server is independent of the Docker test layers in `tests/docker/` (those start their own Nextcloud/WebDAV containers).
