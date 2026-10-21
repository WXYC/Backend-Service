#!/usr/bin/env bash
# Reports whether an image tag exists in ECR (BS#3614).
#
# Used by `.github/workflows/deploy-base.yml` in three places: `build` (skip
# a rebuild when the version is already pushed), `migrate` (every app image
# in the run must exist) and each `deploy` leg (its own image must exist).
#
# A missing image and a failed lookup mean different things, so they exit
# differently. Only a lookup error (throttling, credentials, network) is
# retried, with linear backoff.
#
# Usage (env AWS_REGION; optional ECR_LOOKUP_ATTEMPTS, default 3, and
# ECR_RETRY_DELAY, default 2 seconds):
#   ./scripts/ecr-image-exists.sh <repository> <tag>
#
# Exit:
#   0  the image exists.
#   1  ECR says the image (or the repository) does not exist. Nothing is
#      printed as ::error; the caller says what that means.
#   2  the lookup kept failing for another reason; an ::error names it.
#
# Test coverage: `tests/unit/scripts/ecr-image-exists.test.ts`.

set -uo pipefail

REPO="${1:?usage: ecr-image-exists.sh <repository> <tag>}"
TAG="${2:?usage: ecr-image-exists.sh <repository> <tag>}"
REGION="${AWS_REGION:?AWS_REGION is required}"
ATTEMPTS="${ECR_LOOKUP_ATTEMPTS:-3}"
DELAY="${ECR_RETRY_DELAY:-2}"

ERR=''
for ((i = 1; i <= ATTEMPTS; i++)); do
  # Keep stderr (the error text), drop stdout (the image description).
  if ERR=$(aws ecr describe-images --repository-name "$REPO" --image-ids "imageTag=$TAG" --region "$REGION" 2>&1 >/dev/null); then
    echo "Image $REPO:$TAG is in ECR." >&2
    exit 0
  fi
  if grep -qE 'ImageNotFoundException|RepositoryNotFoundException' <<<"$ERR"; then
    echo "Image $REPO:$TAG is not in ECR." >&2
    exit 1
  fi
  echo "describe-images for $REPO:$TAG failed (attempt $i of $ATTEMPTS): $ERR" >&2
  if [ "$i" -lt "$ATTEMPTS" ]; then
    sleep $((DELAY * i))
  fi
done

echo "::error title=ECR lookup failed::Could not check $REPO:$TAG in ECR after $ATTEMPTS attempts: $ERR" >&2
exit 2
