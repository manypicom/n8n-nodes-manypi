# Publishing and verification

How to take this package from a local folder to a verified node in n8n. The file stays in the repository and is not shipped on npm, because only `dist/`, `README.md` and `LICENSE.md` are published.

n8n's rules, as of September 2026:

- [Submit community nodes](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes)
- [Verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines)
- [UX guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines)

## Where the package stands

| Requirement | Status |
| --- | --- |
| Scaffolded with the n8n node CLI, strict mode | Yes: `@n8n/node-cli` 0.50, `"strict": true` |
| Name starts with `n8n-nodes-` and has the `n8n-community-node-package` keyword | Yes: `n8n-nodes-manypi`, free on npm as of 2026-09-30 |
| No runtime dependencies | Yes: only devDependencies, plus `n8n-workflow` as a peer |
| MIT license | Yes: `LICENSE.md` |
| No environment variables and no file access | Yes |
| English interface and docs | Yes |
| `npm run lint` passes | Yes, with 0 problems |
| n8n's scanner, source and tarball legs (`@n8n/scan-community-package`) | Passes locally. The provenance leg can only run after the first CI publish. |
| Published from GitHub Actions with provenance | `.github/workflows/publish.yml` is in place. See step 4. |
| README with credentials, operations and examples | Yes |

## 1. Fix the endpoint route in manypi-app first

`https://app.manypi.com/v1/e/{slug}` currently redirects every API client to `/signin`. The sign-in middleware runs before the rewrite to the `endpoint-invoke` function, and `/v1` is missing from its public routes. This breaks **Endpoint > Invoke** and **Endpoint > Get Result** in this node. It also breaks the Zapier "Invoke API Endpoint" action and any customer calling their published endpoint URL.

You can reproduce it with this command:

```bash
curl -si https://app.manypi.com/v1/e/anything -H "Authorization: Bearer mpi_x" | head -3
# HTTP/1.1 307 Temporary Redirect
# Location: /signin?redirectedFrom=%2Fv1%2Fe%2Fanything
```

The fix is already in `manypi-app/src/middleware.ts`. It adds `/v1` to `publicRoutes` and is not yet committed or deployed. The edge function authenticates every call itself: it requires an `mpi_` key with the `endpoints:invoke` permission.

Commit and deploy it. Afterwards, the curl above should answer `401 {"error":"Missing or invalid API key..."}` instead of the redirect.

## 2. Test with a real key

```bash
npm install
npm run dev          # starts n8n on http://localhost:5678 with the node loaded
```

`npm run dev` downloads the latest n8n, which needs **Node.js 24 or later**. On Node.js 22 the n8n server fails to install (`EBADENGINE`, then `isolated-vm` does not build) and exits with code 1. Either upgrade Node.js, or use an n8n you already have:

```bash
# terminal 1: build on change and link the node into ~/.n8n-node-cli
npm run dev -- --external-n8n

# terminal 2 (PowerShell): run your installed n8n against that folder
$env:N8N_USER_FOLDER = "$HOME\.n8n-node-cli"; $env:N8N_DEV_RELOAD = "true"; n8n start
```

On Windows, `npm install` can fail while building `isolated-vm`, a dependency of the CLI's bundled n8n. `npm install --ignore-scripts` is enough for lint, build and tests.

Create a ManyPI API credential with a key that has every permission. Then go through at least these:

- [ ] OAuth2: set Authentication to OAuth2, create a ManyPI OAuth2 API credential, click Connect, approve, then run Account > Get
- [ ] Account > Get
- [ ] Scraper > Run with Wait for Completion on, then Scraper Run > Get Data
- [ ] Lead > Create or Update, Get, Update, Get Many and Export
- [ ] Agent Run > Create, then Get
- [ ] Endpoint > Invoke, with an API key
- [ ] ManyPI Trigger > Scraper Run Reached Status: activate it, run a scraper, and check it fires once
- [ ] The ManyPI Tool inside an AI Agent node, asked to "list my scrapers"

Take screenshots as you go. The Creator Portal asks for them.

## 3. Create the public GitHub repository

The npm `repository` URL must match the GitHub repository, and it must be public. `package.json` points at `https://github.com/manypicom/n8n-nodes-manypi`.

```bash
git init -b main
git add .
git commit -m "Initial release of the ManyPI n8n node"
gh repo create manypicom/n8n-nodes-manypi --public --source . --push
```

## 4. First publish, from GitHub Actions

npm trusted publishing (OIDC) cannot do a package's first publish, because the package has to exist before a trusted publisher can be added. So the first release uses a token, and still runs in CI with provenance.

1. On npmjs.com, sign in as the account that should own the package. Go to Access Tokens → Generate New Token → Granular Access Token. Give it read and write access to packages, then narrow it to `n8n-nodes-manypi` once the package exists.
2. In the GitHub repository, go to Settings → Secrets and variables → Actions → New repository secret. Name it `NPM_TOKEN`.
3. Locally, run `npm run release`. It lints, builds, asks for the version, updates `CHANGELOG.md`, commits, tags and pushes. The tag triggers `publish.yml`, which publishes with `--provenance`.
4. Check the result:

   ```bash
   npm view n8n-nodes-manypi dist.attestations    # must list a provenance attestation
   npx @n8n/scan-community-package n8n-nodes-manypi
   ```

   Run the scanner on macOS or Linux, for example in Codespaces. Its source download uses a `tar` call that fails on Windows paths.

`publishConfig.access` is set to `public`. The Keupera node's first release failed without it.

## 5. Switch to trusted publishing

1. On npmjs.com, open the package → Settings → Trusted Publisher → GitHub Actions. Enter owner `manypicom`, repository `n8n-nodes-manypi`, workflow `publish.yml`, and leave the environment blank.
2. Delete the `NPM_TOKEN` secret from GitHub, and revoke the token on npm.

From then on, `npm run release` publishes with no stored secret.

## 6. Submit for verification

Go to [creators.n8n.io/nodes](https://creators.n8n.io/nodes) and sign in. The form asks for the npm package name, the GitHub repository, short and long descriptions, example workflows and screenshots. n8n usually asks for a short demo video after the first review.

**Package:** `n8n-nodes-manypi`
**Repository:** `https://github.com/manypicom/n8n-nodes-manypi`

**Short description:**

> Find and verify leads, and run cold email outreach from your own inboxes, with ManyPI.

**Long description:**

> ManyPI is an AI sales platform for lead generation and cold email outreach. Describe your ideal customer and its agent finds matching companies and contacts, verifies their email addresses, and sends your sequences from your own inboxes. The ManyPI node covers the whole workflow: start lead searches, create, update and export leads, verify addresses, build sequences, run campaigns and enroll leads, send one-off emails, read replies with their sentiment, and keep a do-not-contact list. The ManyPI Trigger starts workflows when a lead is saved, a campaign gets a reply, or an agent run finishes. Sign in with OAuth2 or an API key, and use the node as a tool for the n8n AI Agent.

**Example workflows** to attach, as exports from step 2. The README lists more.

1. Schedule Trigger → ManyPI Lead Search > Start, with a saved search
2. ManyPI Trigger New Lead → ManyPI Email Verification > Verify; then ManyPI Trigger Email Verification Reached Status → ManyPI Campaign > Enroll Leads
3. ManyPI Trigger New Reply, filtered to positive sentiment → HubSpot Create or Update Contact

## Releasing later versions

Run `npm run release` on a clean `main`. Pick a patch version for fixes and a minor version for new operations. The workflow publishes on the tag. Never run `npm publish` locally: `prepublishOnly` blocks it, and n8n does not accept packages published from a local machine.
