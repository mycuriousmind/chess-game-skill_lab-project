# Presentation security notes

This project is configured for a local presentation environment. Review and
replace the temporary settings before using it outside the local machine.

## Temporary presentation credentials

The local MongoDB demo setup uses credentials configured outside the repository.
They must not be committed, shared publicly, or reused in production.

- MongoDB administrator credentials are for administration only.
- The `house_chess` application user should be limited to read/write access to
  the `house_chess` database.
- The demo `AUTH_SECRET` must be replaced with a long, randomly generated
  secret before deployment.
- Changing `AUTH_SECRET` invalidates existing browser login tokens.

## Before deployment

1. Replace all demo MongoDB passwords.
2. Replace the development authentication secret.
3. Store connection strings and secrets in the hosting provider's secret
   manager or environment configuration.
4. Do not commit `.env` files, passwords, MongoDB URIs containing passwords,
   tokens, local database files, or service configuration files.
5. Enable MongoDB authorization and use a least-privilege application user.
6. Use MongoDB Atlas or another protected deployment; do not expose the local
   MongoDB service to the public internet.
7. Configure HTTPS and restrict `CORS_ORIGIN` to the real frontend origin.
8. Configure encrypted backups, retention, restore testing, and monitoring.
9. Run the backend with `NODE_ENV=production`; production startup requires
   `AUTH_SECRET` and `CORS_ORIGIN`.
10. Rotate any credential that may have appeared in terminal history, screen
    recordings, screenshots, chat, or presentation materials.

## Local presentation limitations

The local server uses HTTP on `localhost`, and the local MongoDB installation
is intended only for the presentation. Active game recovery and database
persistence are implemented, but this setup is not a production deployment.

## Safe checks

From the repository root:

```powershell
git status
git diff --check
```

Before committing, scan the staged diff and confirm that no real credentials
or connection strings are present:

```powershell
git diff --cached | Select-String `
  -Pattern "password|AUTH_SECRET|MONGODB_URI|mongodb\+srv://" `
  -CaseSensitive:$false
```

An empty result is preferred. The development fallback string in
`backend/server.js` is intentionally a guard for local development and must
be replaced or supplied through the environment before production use.
