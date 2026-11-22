#!/usr/bin/env bash
# Run with an immutable ECR repository URI. Reuse a previously published commit.
set -euo pipefail
repository_uri=${1:?ECR repository URI required}
repository_name=${repository_uri#*/}
registry=${repository_uri%%/*}

lookup() {
  aws ecr batch-get-image --repository-name "$repository_name" --image-ids "imageTag=$GITHUB_SHA" \
    --output json --query '{digests: images[].imageId.imageDigest, failures: failures[].failureCode}' |
    jq -er 'if (.digests | length) == 1 and .failures == [] then .digests[0]
            elif .digests == [] and .failures == ["ImageNotFound"] then "missing"
            else error("Could not resolve release image") end'
}

digest=$(lookup)
if [[ "$digest" == missing ]]; then
  docker buildx build --platform linux/amd64 --provenance=false \
    --build-arg "MIZUHO_RELEASE_SHA=$GITHUB_SHA" --label "org.opencontainers.image.revision=$GITHUB_SHA" \
    --tag "$repository_uri:$GITHUB_SHA" --load .
  python3 deploy/aws/verify_release.py
  aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
  trap 'docker logout "$registry" >/dev/null' EXIT
  docker push "$repository_uri:$GITHUB_SHA"
  digest=$(lookup)
fi
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::Invalid ECR digest"; exit 1; }
echo "image_uri=$repository_uri@$digest" >> "$GITHUB_OUTPUT"
