# Production deployment

Production URL: https://caught-in-4k-app.vercel.app

The `Deploy production to Vercel` GitHub Actions workflow deploys every push or merge
to `main`. Branch work reaches production when it is merged into `main`. A manual
run is also available from the repository's Actions tab.

## Credentials and project settings

The workflow requires the encrypted repository secret `VERCEL_DEPLOY_TOKEN`: a
dedicated Vercel access token scoped to the Caught in 4K project. Do not use a
short-lived CLI login token or commit a token to the repository. Set its expiration
when creating it, and replace the secret before it expires or after revocation.

The workflow names the existing `iw9/caught-in-4k-app` project explicitly. Build and
runtime environment variables remain managed in Vercel. Its root directory is
`apps/web`, with access to workspace sources outside that directory. Each run
uploads the exact pushed commit's tracked source and lets Vercel build it using the
current production configuration. No local `.env` files are uploaded.

The voice guide reads `DEEPSEEK_API_KEY` and `TYPESAFE_API_KEY` on the server.
Store their values as encrypted Vercel production environment variables. Copies
are also saved as repository Actions secrets under the same names; Actions secrets
are not automatically exposed to the deployed application or synchronized to
Vercel. When rotating either key, update both secret stores and redeploy production.
Only empty placeholders belong in `.env.example`; neither key is a `NEXT_PUBLIC_`
variable. The guide separately requires `GUIDE_TOKEN` for request authorization.

Deployments are serialized to keep an older run from overwriting a newer one.
Vercel's CLI waits for the build; a failed build fails the workflow. A final request
checks that `/camera` is publicly reachable. The `sourceCommit` deployment metadata
records the GitHub commit SHA.

The built-in Vercel Git integration currently blocks some teammate-authored commits
because of its deployment-author permissions. The Actions workflow instead uses
the dedicated CI credential. It does not alter commit authors or grant teammates
access to unrelated Vercel projects.

## "Try your video" backend (Modal)

The public `/upload` tab sends a visitor's video straight from the browser to a
separate backend on [Modal](https://modal.com), `worker/modal_app.py`. Vercel only
serves the page. Each upload runs `recyclone_worker/job.py` (the
`guide --prepared --render` pipeline) on a GPU. The result is kept for 24 hours.

One-time setup, by someone with the team's Modal account:

```bash
pip install modal && modal token new          # interactive login
modal secret create caught-in-4k \
  ANTHROPIC_API_KEY=... TYPESAFE_API_KEY=... ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=...
modal deploy worker/modal_app.py              # prints the api URL (https://<workspace>--caught-in-4k-api.modal.run)
```

Then set that URL as `NEXT_PUBLIC_UPLOAD_API_URL` in the Vercel project and
redeploy. Without it, the tab says that uploads are off. `modal serve
worker/modal_app.py` gives a temporary development URL that reloads on save.

Limits are provisional and are read at deploy time, e.g. `UPLOAD_GPU=L4 modal deploy …`:

| Variable | Default |
| --- | --- |
| `UPLOAD_GPU` | `T4`; `cpu` runs on 8 CPUs instead, which is slower but works without a payment method on the Modal account |
| `UPLOAD_MAX_CONTAINERS` | `3` (concurrent jobs; the rest queue) |
| `UPLOAD_MAX_MB` | `150` |
| `UPLOAD_PER_IP_PER_HOUR` | `20` (a shared Wi-Fi network is one address) |
| `UPLOAD_PER_DAY` | `200` (all visitors) |
| `UPLOAD_ALLOWED_ORIGINS` | production URL and `http://localhost:3000` (CORS) |

The image pins weights from the Hugging Face repo `eymen160/caught-in-4k` at a fixed
revision and checks them against its `SHA256SUMS`. Jev is called over its HTTP API
when the `jev` CLI is not installed, which is the case in the image.

Uploaded videos are processed in the cloud, unlike store footage. Modal holds the
video until the job ends and the result for 24 hours. Only face-blanked item crops
go to Claude; only sentence text goes to ElevenLabs. Processing time per clip has
not been measured yet.

## Verification and limits

Check the Actions run and Vercel deployment status before claiming a release is
live. An accessible camera page does not establish model accuracy, camera access on
every device, configured provider keys, or an operational backend. Browser camera
and audio permissions are still controlled by each visitor's device.
