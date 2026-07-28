#!/usr/bin/env bash
# Authenticate Drive uploads AS YOU.
#
# A service account cannot own files on a personal Google account (no storage
# quota), so drive-upload.js uses Application Default Credentials instead.
# Sheets is separate and uses the service-account key — see sheets-sync.js.
#
# Run:  ./gcloud-login.sh
set -euo pipefail

GCLOUD="$HOME/google-cloud-sdk/bin/gcloud"
SCOPES="openid"
SCOPES="$SCOPES,https://www.googleapis.com/auth/cloud-platform"
SCOPES="$SCOPES,https://www.googleapis.com/auth/drive.file"

echo "Requesting scopes:"
printf '  %s\n' ${SCOPES//,/ }
echo
exec "$GCLOUD" auth application-default login --no-launch-browser --scopes="$SCOPES"
