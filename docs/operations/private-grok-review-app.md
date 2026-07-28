# Private Grok Review GitHub App operations

This runbook deploys and qualifies the private, single-tenant Grok Review
GitHub App. Target repositories require **no committed workflow, secret, auth
watcher, or other integration file**. The App may be installed on selected or
all repositories, including repositories that accept pull requests from forks;
the central runner reads bounded Git data and never executes fork or target
code.

Keep any existing per-repository `grok-pr-review.yml` path in place during that
repository's qualification. Migration is a separate, gated final step.
When the central control repository is also a target, migrate only its
per-repository review workflow; its central App worker, `GROK_AUTH_JSON`, and
single auth watcher must remain.

## 1. Deployment identities and key separation

Use distinct identities and credentials:

| Credential | Stored in | Purpose |
|---|---|---|
| GitHub App webhook secret | Worker secret `WEBHOOK_SECRET` | Authenticate raw GitHub webhooks |
| Central dispatch token | Worker secret `CONTROL_REPO_TOKEN` | Actions write on the central control repository only |
| Callback HMAC key | Worker and central secrets named `RUNNER_CALLBACK_SECRET` | Authenticate runner callbacks |
| GitHub App RSA private key | Central secret `GROK_REVIEW_APP_PRIVATE_KEY` | Mint App JWTs and exact-repository installation tokens |
| Grok login JSON | Central secret `GROK_AUTH_JSON` | Authenticate the tool-free Grok provider |
| Ed25519 receipt private key | Central secret `RECEIPT_SIGNING_PRIVATE_KEY` | Sign sanitized review receipts |
| Ed25519 receipt public-key map | Worker secret `RECEIPT_PUBLIC_KEYS_JSON` | Verify receipts before D1 acceptance |

The GitHub App RSA key and receipt Ed25519 key are unrelated keys. Do not reuse
one for the other. The Worker gets only the receipt public-key map; it never
gets either private key. Target installations get neither.

Both HMAC keys (`WEBHOOK_SECRET` and `RUNNER_CALLBACK_SECRET`) must encode to
32–4096 UTF-8 bytes and contain no control characters. The Worker returns a
configuration error before reading or authenticating a request when either key
violates this contract.

Prepare these non-secret central Actions variables:

- `GROK_REVIEW_APP_CLIENT_ID`
- `GROK_REVIEW_APP_ID`
- `GROK_REVIEW_WORKER_URL`
- `GROK_REVIEW_RUNTIME_COMMIT`
- `GROK_REVIEW_RUNTIME_BUNDLE_SHA256`
- `GROK_CLI_VERSION` set to exact version `0.2.112`
- `RECEIPT_SIGNING_PUBLIC_KEY`
- optional `GROK_MODEL` and `GROK_EFFORT`

Prepare these non-secret Worker vars:

- `CONTROL_REPO_OWNER`
- `CONTROL_REPO_NAME`
- `CONTROL_WORKFLOW_FILE` set to `grok-review-app-worker.yml`
- `CONTROL_REF`
- `GITHUB_APP_ID`

Do not place real IDs, repository coordinates, deployed URLs, tokens, or keys in
the repository. Keep environment-specific Wrangler configuration outside Git
and set GitHub values through repository settings or `gh`.

## 2. Create D1 and deploy the Worker

From `apps/grok-review-app`, authenticate Wrangler to the intended Cloudflare
account and create the database:

```bash
npx wrangler whoami
npx wrangler d1 create grok-review-control
```

Copy `wrangler.toml` to a secure environment-specific deployment config outside
the checkout. Replace only that copy's placeholder D1 UUID and empty vars. Pass
that file as `<DEPLOY_CONFIG>` below; never commit it.

List and apply the checked-in migrations:

```bash
npx wrangler d1 migrations list grok-review-control --remote --config <DEPLOY_CONFIG>
npx wrangler d1 migrations apply grok-review-control --remote --config <DEPLOY_CONFIG>
```

Cloudflare records applied migrations in D1; review the pending list before each
apply. See [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

Set Worker secrets interactively so values do not appear in command arguments:

```bash
npx wrangler secret put WEBHOOK_SECRET --config <DEPLOY_CONFIG>
npx wrangler secret put RUNNER_CALLBACK_SECRET --config <DEPLOY_CONFIG>
npx wrangler secret put CONTROL_REPO_TOKEN --config <DEPLOY_CONFIG>
npx wrangler secret put RECEIPT_PUBLIC_KEYS_JSON --config <DEPLOY_CONFIG>
```

`CONTROL_REPO_TOKEN` must be fine-grained and limited to Actions write on the
one central control repository. `RECEIPT_PUBLIC_KEYS_JSON` is the trusted
Ed25519 public-SPKI map keyed by the key ID derived by the runner from the
public SPKI. Keep old public keys only for the bounded receipt-verification
overlap needed during key rotation.

Deploy and record the resulting HTTPS origin in the protected deployment
inventory, not in this checkout:

```bash
npx wrangler deploy --config <DEPLOY_CONFIG>
```

Cloudflare recommends secrets rather than plaintext vars for sensitive values;
see [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 3. Register and install the private GitHub App

First verify the deployed public health route:

```bash
curl --fail --silent --show-error https://<WORKER_HOST>/healthz
```

Create a secure temporary copy of
`apps/grok-review-app/github-app-manifest.template.json` and replace the
reserved `grok-review.example.invalid` host with `<WORKER_HOST>`. Use it with
GitHub's App manifest registration flow, or transcribe the same fields in the
GitHub App registration UI. GitHub's supported manifest fields are documented
in [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
If a manifest-registration helper needs a `redirect_url` to receive the
one-time registration code, add that operator-owned HTTPS endpoint only to the
secure temporary copy. It is a registration redirect, not permission to enable
OAuth authorization during installation.

Before saving, verify:

- the App is private (`public: false`);
- OAuth authorization during installation is disabled
  (`request_oauth_on_install: false`);
- webhook delivery is active at
  `https://<WORKER_HOST>/github/webhooks`;
- repository permissions are exactly Contents read, Pull requests write,
  Checks write, Issues read, and Metadata read;
- subscribed events are exactly `pull_request`, `issue_comment`, `check_run`,
  `installation`, and `installation_repositories`;
- there are no Actions, Workflows, Administration, Secrets, user, or
  organization permissions.

Save the generated App ID and client ID as protected deployment metadata.
Generate and download one GitHub App RSA private key. Store it directly as the
central `GROK_REVIEW_APP_PRIVATE_KEY` secret, then remove unsecured copies according
to the operator's key-retention policy. Set the App webhook secret to the same
high-entropy value already configured as Worker `WEBHOOK_SECRET`.

Install the App on a disposable test repository first. Select only the
repository intended for the first live proof. Adding or removing repositories,
suspending, unsuspending, and uninstalling the App must update Worker/D1
installation state through the subscribed lifecycle webhooks.

GitHub Apps start without permissions and should request the minimum needed;
see [Choosing permissions for a GitHub App](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## 4. Configure the central Actions runner

The central control repository contains the only Grok review workflow and the
only `GROK_AUTH_JSON` secret after migration. Configure:

Secrets:

```text
GROK_REVIEW_APP_PRIVATE_KEY
GROK_AUTH_JSON
RUNNER_CALLBACK_SECRET
RECEIPT_SIGNING_PRIVATE_KEY
```

Variables:

```text
GROK_REVIEW_APP_CLIENT_ID
GROK_REVIEW_APP_ID
GROK_REVIEW_WORKER_URL
GROK_REVIEW_RUNTIME_COMMIT
GROK_REVIEW_RUNTIME_BUNDLE_SHA256
GROK_CLI_VERSION
RECEIPT_SIGNING_PUBLIC_KEY
GROK_MODEL                 # optional
GROK_EFFORT                # optional
```

Set `GROK_REVIEW_RUNTIME_COMMIT` to the exact trusted plugin commit, never a
mutable branch name. From a clean checkout of that commit, derive the matching
archive digest and store it as `GROK_REVIEW_RUNTIME_BUNDLE_SHA256`:

```bash
git archive --format=tar <TRUSTED_COMMIT> | shasum -a 256
```

Set `GROK_CLI_VERSION` to `0.2.112`. The workflow and runtime must verify the
pinned package/runtime integrity before provider launch.
Production rollout additionally requires the prebuilt digest-verified runtime
bundle; mutable per-run package installation is prototype-only.

Generate the receipt Ed25519 key pair separately from the GitHub App RSA key.
Store the private key as PKCS#8 PEM in `RECEIPT_SIGNING_PRIVATE_KEY`. Export the
public SPKI PEM as `RECEIPT_SIGNING_PUBLIC_KEY`, derive its key ID from that
same SPKI, and add the identical public key under that ID in the Worker's
`RECEIPT_PUBLIC_KEYS_JSON`. The runner must reject a public/private mismatch.

Use the existing auth watcher for the central control repository:

```bash
npm run grok:ci-auth:install -- \
  --repo <OWNER>/<CONTROL_REPO> \
  --gh-bin <ABSOLUTE_GH_PATH>
```

Run `grok login` under the dedicated review identity before installation, then
confirm the watcher reports synchronized:

```bash
npm run grok:ci-auth:status -- --repo <OWNER>/<CONTROL_REPO>
```

Do not install auth watchers in new target repositories. Existing target
watchers may remain only while their legacy workflow participates in the
dual-run gate; remove them immediately after the gate passes.

## 5. Verify ingress and installation lifecycle

Use the GitHub App settings page to inspect webhook deliveries without copying
payload bodies into issue comments or logs.

1. Redeliver a signed webhook and confirm a `2xx` response.
2. Redeliver the same delivery and confirm it is a digest-matched no-op.
3. Confirm a delivery ID with a mismatched digest fails closed.
4. Add and remove a test repository from the installation.
5. Suspend and unsuspend the installation.
6. Confirm D1 records only installation/repository IDs, delivery digests,
   request/check/workflow state, and sanitized receipts.
7. Confirm Worker logs contain no repository code, diff, prompt, instruction
   content, GitHub token, Grok credential, or receipt body.
8. Confirm webhook responses do not depend on GitHub Actions network latency:
   admission and its outbox row must commit first, and the scheduled drain must
   recover a deliberately failed or interrupted dispatch.
9. Confirm the workflow watchdog terminalizes only a bound central run that
   GitHub authoritatively reports as completed; age alone must never fabricate
   a failure.

The webhook signature must be checked against the raw request body before
parsing, following GitHub's
[webhook validation guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## 6. Smallest real vertical

Run the first live proof on a disposable installed repository:

```text
install App
→ open non-draft PR
→ signed webhook
→ Worker + D1 admission
→ central macos-latest workflow
→ exact-head collection
→ actual Grok provider launch
→ App-authored Check and COMMENT review
→ verified sanitized receipt
```

The PR must be safe to inspect without executing anything from it. Verify the
central job did not run the target's hooks, Actions, submodules, package
manager, tests, or project configuration, and that no GitHub credential existed
in the Grok child environment.

Do not treat unit tests, a dispatched workflow without provider launch, a model
claim, or a locally generated receipt as lifecycle qualification.

## 7. Live qualification matrix

Keep the legacy per-repository workflow active and run both paths on the same
heads. Record the exact base/head SHAs, input digests, finding identity, and
receipts for comparison.

### Clean PR

- Open a non-draft PR with no intended findings.
- Confirm the App-authored Check appears on the exact current head.
- Confirm `grok-review[bot]` submits one native `COMMENT` review containing the
  Grok summary and explicit zero-finding evidence.
- Confirm the receipt says the real provider launched and structured output
  validation passed.

### Known-defect PR

- Open a disposable PR containing one deterministic review defect on an added
  RIGHT-side line.
- Confirm the App-authored review includes an inline finding.
- Include a safe structured replacement and confirm it renders as a GitHub
  suggestion only when the full range maps to that exact head's RIGHT-side
  diff.
- Change the head so a prior range no longer maps and confirm the suggestion
  degrades to an ordinary finding rather than being posted at the wrong line.

### Update and supersession

- Push a new commit and confirm `synchronize` creates a new exact-head request.
- Keep an older run in flight, push again, and confirm the older request is
  cancelled or marked superseded only after the newer run's live authority
  fence, and does not publish as the current review.
- Deliver an older-head webhook after a newer request and confirm webhook
  arrival alone does not supersede the newer work.
- Compare the posted review's `commit_id`, Check SHA, receipt head SHA, and live
  PR head.

The GitHub Reviews API supports a `commit_id` and PENDING reviews, but has no
documented atomic conditional-current-head field or idempotency key. The runner
must create/reconcile its pending review, re-fetch the live head immediately
before submitting `COMMENT`, and mark detected post-submit drift superseded.
This narrows and exposes the final API-call race; it cannot honestly eliminate
it. See the [Pull request Reviews API](https://docs.github.com/en/rest/pulls/reviews).

### Instructions

- Add root `AGENTS.md` guidance on the PR head and confirm it changes review
  guidance without changing the runner's security or output contract.
- Add nested `AGENTS.md` guidance and confirm it applies only below that
  directory and takes precedence over root guidance.
- Confirm receipt instruction paths and blob digests match the exact head.
- Confirm symlinks are not followed and over-limit instructions produce a
  visible configuration failure.

### Manual authorization

- Click `Run Grok review` / `Re-run Grok review` on the completed Check.
- Post exactly `@grok-review review` as a collaborator with current `write`,
  `maintain`, or `admin` access.
- Repeat as a read-only or external user and confirm the central authorization
  gate stops before provider launch, review posting, or Grok quota use. The
  small central authorization job may already have been dispatched because the
  Worker deliberately holds no target-repository App credential.
- Confirm that this rejected manual request does not supersede or cancel an
  already-authorized automatic or manual review for the same pull request.
- Confirm drafts are not automatically reviewed but an authorized manual
  command can review the current draft head.

GitHub requested actions expose a Check button and deliver
`check_run.requested_action`; see
[Using the REST API to interact with checks](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks).

### Reviewer picker prototype

On an installed test repository, check whether GitHub offers the App bot in the
Reviewers picker and whether selecting it produces an actionable App event.
Record the observed GitHub behavior. This appearance is not guaranteed and is
not an acceptance dependency. Do not create a machine user or PAT fallback.
The supported manual interfaces remain the Check action and exact mention.

## 8. Migration gate

Do **not** remove any target repository workflow, secret, or auth watcher until
one dual-run live qualification proves all of the following:

- the review and Check are authored by the installed GitHub App;
- review, Check, diff, instruction blobs, and receipt bind the exact current
  head;
- the actual Grok provider launched successfully;
- a clean PR receives a visible zero-finding summary;
- a known-defect PR receives an inline finding and an applicable suggestion;
- each new push dispatches a new exact-head review and supersedes older work;
- root and nested `AGENTS.md` guidance is applied from the exact head;
- the Check action and exact `@grok-review review` command both dispatch;
- unauthorized manual callers cannot consume quota;
- ambiguous posting is reconciled by the host receipt marker rather than
  blindly duplicated;
- no target or fork code was executed and no target repository needed an App
  integration file or secret.

If any item is missing, keep the legacy path and mark the App unqualified.

### Operator-approved central-repository exception

For `xliberty2008x/grok-plugin`, the repository owner explicitly approved
retiring only the duplicate per-repository workflow after live proof of the
installed App, automatic exact-head dispatch, an actual Grok provider run,
zero-finding and inline-finding reviews, an applicable suggestion, stale-head
supersession, root and nested `AGENTS.md`, and the Check requested action.

This narrow exception does not mark unobserved surfaces as qualified. A manual
command from a read-only or external human and a deliberately ambiguous GitHub
posting response remain residual live checks; report them as such rather than
simulating them. The exception does not apply to other target repositories and
does not authorize removal of the central App worker, central
`GROK_AUTH_JSON`, or its single auth watcher. Roll back by reverting the commit
that removed the per-repository workflow.

After the entire gate passes, migrate each target repository individually:

1. Remove `.github/workflows/grok-pr-review.yml`.
2. Delete the target repository Actions secret `GROK_AUTH_JSON`.
3. Uninstall that target repository's repo-scoped Grok auth watcher.
4. Confirm the App remains installed on the intended repository selection.
5. Open or update one PR and confirm the App-only path still produces a
   current-head review and Check.

Keep exactly one auth watcher and `GROK_AUTH_JSON`: the watcher and secret for
the central control repository.

## 9. Ongoing operations

- Rotate webhook, callback, App RSA, Grok, dispatch-token, and receipt keys on
  separate schedules; never conflate their roles.
- During receipt-key rotation, publish the new public key to the Worker before
  switching the central signing key, verify one live receipt, then retire the
  old public key after the bounded overlap.
- Treat uninstall or repository removal during a job as terminal authorization
  loss; do not post.
- Preserve only sanitized receipts and control metadata in D1.
- Monitor failed/expired outbox leases and completed central workflow runs that
  lack terminal callbacks. The watchdog may reconcile only an exact bound
  workflow run after validating its repository, event, and workflow identity.
- A hard runner termination can leave an App Check visibly in progress because
  the Worker deliberately has no App private key. Treat cleanup of that Check
  as a live-qualification observation; never let the Worker mint target
  installation credentials merely to hide a control-plane failure.
- Re-run the clean and known-defect vertical after changing App permissions,
  collector boundaries, token phases, review schema, receipt schema, runtime
  pin, or Grok CLI version.
- A test suite passing without the installed live App lifecycle is supporting
  evidence only, never production qualification.
