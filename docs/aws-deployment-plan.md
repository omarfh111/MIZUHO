# Deploy the judge demo on AWS

MIZUHO runs as one Linux container on ECS Fargate. ECS Express Mode supplies a public HTTPS address and certificate. The same address serves the dashboard, FastAPI and the Voice Guardian WebSocket. A judge signs in once and can then open the Tunisia map, compare plans and use the microphone. The owner can add a custom hostname later. [AWS service endpoints](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-getting-started.html)

## What runs where

| Component | Deployment |
| --- | --- |
| Browser and API | A Node 22 build produces the live React dashboard. A non-root Python 3.12 container serves its files, the existing API and the Guardian socket on port 8000 behind the AWS HTTPS listener. The image includes the regional datasets, scenario inputs and local evidence passages. |
| Access | The public `GET /deploy-healthz` exposes liveness and the image's Git revision. All application routes require judge credentials. Successful HTTP sign-in creates a secure, HTTP-only session cookie. Browser writes and voice connections must come from the same HTTPS origin. Manager approval uses a separate code. |
| Service size and availability | Two vCPUs and 4 GiB on one steady-state Fargate task with one Uvicorn worker. This supports a supervised demo. Deployments, restarts and task failures can interrupt a call and clear process-local sessions. Exercise concurrent judge sessions before inviting a larger audience. |
| Providers | Fargate injects individual secret values when the task starts. The existing OpenAI embeddings, Qdrant collection, language and speech providers remain external. A healthy container proves that the application started. Test providers separately before judging. |
| Release record | The workflow pins the image by ECR digest, records the Git SHA and checks that the public endpoint reports that SHA. Application logs go to CloudWatch for 14 days. |

## One-time owner setup

1. Choose the AWS account and region. The reference configuration uses Paris (`eu-west-3`). Use an operator identity with MFA for bootstrap. Confirm a default VPC with at least two public subnets in distinct availability zones, a route to an internet gateway and enough free IPv4 addresses for the load balancer (at least eight per selected subnet). Set the event budget and teardown date. Costs include running Fargate tasks, the Application Load Balancer, public IPv4 addresses, ECR, Secrets Manager, logs, data transfer and external providers. [Express Mode resources](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html) · [AWS Pricing Calculator](https://calculator.aws/)
2. In Secrets Manager in the same region, create one JSON key/value secret with the default Secrets Manager encryption key. Use the following exact keys. Keep the full secret ARN for bootstrap and the release environment. Only the task execution role reads the values. [Create a secret](https://docs.aws.amazon.com/secretsmanager/latest/userguide/create_secret.html)
3. Establish GitHub's OIDC identity provider in that AWS account with audience `sts.amazonaws.com`. Reuse the provider if it already exists. Use the two bootstrap templates below to create the release and execution roles. The account-wide role names support one regional judge deployment per account. [GitHub OIDC on AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
4. Create a GitHub environment named `aws-demo` and restrict its deployment branch to `main`. Configure its variables from the table below. Protect the workflow and the environment as release controls. [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

| Secret key | Value |
| --- | --- |
| `MIZUHO_JUDGE_USER` | Judge login for this supervised demo. Share it and its password privately. |
| `MIZUHO_JUDGE_PASSWORD_HASH` | Generate locally with `python -m backend.deployment` from the repository root. Enter the new judge password at the hidden prompts and store the resulting salted hash in this field. |
| `MIZHUO_MANAGER_APPROVAL_CODE` | Separate manager-only code for approval actions. |
| `OPENAI_API_KEY`, `LLM_API_KEY` | OpenAI credentials for embeddings and configured inference, and the NVIDIA language provider key. |
| `QDRANT_URL`, `QDRANT_API_KEY` | Endpoint and credentials for the existing evidence collection. The default collection is `mizhuo_m8_evidence_v1`. |
| `VULTR_INFERENCE_API_KEY` | Credentials for live speech recognition and synthesis. |

Each key must exist in the JSON secret. Complete all provider fields for a connected judge demonstration. The image uses the model defaults in the application. A secret rotation takes effect when ECS starts replacement tasks. [ECS secret injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)

### Bootstrap the roles

Run from the repository root before the first release, using an AWS CLI provisioning profile with permission to create the IAM roles. These commands create account resources. Supply the secret ARN as `$RuntimeSecretArn`, the profile name as `$OperatorProfile`, and use the same AWS region for all four stacks.

On Windows, set `$env:AWS_CLI_FILE_ENCODING = 'UTF-8'` when loading local templates. If your network uses TLS inspection, point `AWS_CA_BUNDLE` at its approved PEM trust bundle. The AWS CLI uses that bundle to verify service certificates. [AWS CLI environment variables](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html)

```powershell
$Region = 'eu-west-3'
aws cloudformation deploy --profile $OperatorProfile --region $Region --stack-name mizuho-demo-stack-role --template-file deploy/aws/stack-role.yml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides "RuntimeSecretArn=$RuntimeSecretArn"
if ($LASTEXITCODE -ne 0) { throw 'Stack role bootstrap failed' }
$StackRole = aws cloudformation describe-stacks --profile $OperatorProfile --region $Region --stack-name mizuho-demo-stack-role --query "Stacks[0].Outputs[?OutputKey=='CloudFormationRoleArn'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or !$StackRole -or $StackRole -eq 'None') { throw 'Missing CloudFormation role' }
```

Create the GitHub release role using the execution role ARN from the previous command. Its trust policy identifies this repository and the protected `aws-demo` environment.

```powershell
aws cloudformation deploy --profile $OperatorProfile --region $Region --stack-name mizuho-demo-github-role --template-file deploy/aws/bootstrap.yml --capabilities CAPABILITY_IAM --parameter-overrides "CloudFormationRoleArn=$StackRole"
if ($LASTEXITCODE -ne 0) { throw 'GitHub role bootstrap failed' }
aws cloudformation describe-stacks --profile $OperatorProfile --region $Region --stack-name mizuho-demo-github-role --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue | [0]" --output text
```

| GitHub environment variable | Source |
| --- | --- |
| `AWS_REGION` | Chosen deployment region |
| `AWS_DEPLOY_ROLE_ARN` | GitHub OIDC release role from the bootstrap stack |
| `AWS_CLOUDFORMATION_ROLE_ARN` | `CloudFormationRoleArn` from the stack role bootstrap |
| `MIZUHO_RUNTIME_SECRET_ARN` | Full ARN used when bootstrapping the stack role |

The GitHub job can publish an image and delegate to CloudFormation. ECS has its own narrowly scoped execution role to fetch its image, inject the runtime secret and write logs. Only the account bootstrap identity creates these IAM roles. [Release workflow](../.github/workflows/aws-release.yml) · [Service template](../deploy/aws/service.yml)

## Publish and verify

1. Merge the deployment code into `main` after review. Wait for CI and Security to pass on the resulting push SHA, including both browser jobs. A feature-branch push runs validation only.
2. In **Actions → AWS release → Run workflow**, select `main`. The workflow checks that the dispatched SHA still matches the tip of `main` and has passing release checks. It provisions or reuses the registry, publishes the image under an immutable SHA tag, deploys by digest and verifies the live revision and anonymous access challenge. If `main` advances, dispatch a fresh run.
3. Open the HTTPS link in the workflow summary. Sign in with the judge credential. Go to `/?intro=0&lang=en#tunisia`, select a city and open a second regional site. In Jendouba's simulated miniature, verify A/B allocations of 10/0 m³ for the fixed schedule and 5/5 m³ for the optimized schedule. The least-served parcel moves from 0% to 50% coverage at the same quota.
4. Open a dated Bouhertma station observation. Check the assistant index and open a source passage from a documentary answer. Start Voice Guardian, allow microphone access and try a Japanese follow-up after a pause of more than one minute. Verify that a manager must approve a simulated quota reduction. Live voice and inference may incur provider charges.
5. Record the release SHA, image digest, endpoint and previous healthy image. Review request failures, solver latency and memory under the expected number of simultaneous sessions. Confirm fresh sessions work after a task replacement.

## Rollback and cost control

The service uses CloudFormation updates and ECS health checks. For an application regression after a successful release, prefer reverting the change through Git, waiting for green checks on the new `main` tip and running **AWS release** again. For urgent recovery, an authorized operator can update the service stack to the previous known-good digest with its original registry and secret configuration. Verify that `/deploy-healthz` reports that image’s SHA and repeat the judge-access and voice checks. [ECS deployment behavior](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html)

At the end of the event, delete the service stack first. Verify that AWS has removed its tasks and retired its load balancer or released it for other services sharing it. The release retains task-definition revisions and tagged ECR images for rollback. Before a later deployment, reuse the existing registry stack or import the retained repository by name. Review residual image storage, secrets, logs and network charges. Retire bootstrap roles separately when future releases are no longer needed. Keep shared provider accounts and the Qdrant collection under their existing owners.

## Local verification

```sh
docker build --platform linux/amd64 --tag mizuho:ci .
npm --prefix frontend ci
node frontend/tests/aws-container-browser.mjs
```

The smoke test runs a temporary TLS proxy and Chrome against the production image, using disposable credentials. It checks anonymous access, the live Tunisia map, the computed A/B allocation and a Japanese Guardian WebSocket greeting. CI also validates the CloudFormation templates, runs the existing backend and frontend suites, checks TypeScript and builds the dashboard.
