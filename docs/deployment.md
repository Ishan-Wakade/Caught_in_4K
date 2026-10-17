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

## Verification and limits

Check the Actions run and Vercel deployment status before claiming a release is
live. An accessible camera page does not establish model accuracy, camera access on
every device, configured provider keys, or an operational backend. Browser camera
and audio permissions are still controlled by each visitor's device.
