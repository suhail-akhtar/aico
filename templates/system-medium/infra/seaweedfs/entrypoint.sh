#!/bin/sh
# SeaweedFS in one process (master, volume, filer and the S3 gateway) for local use.
#
# The S3 identity is written from the environment into /tmp at start, so the access and secret
# keys never live in a file in git. /tmp is a tmpfs: the file disappears with the container.
# A production deployment uses a managed S3 service or a proper SeaweedFS cluster; the application
# only needs an S3 endpoint, a bucket and a key pair.
set -eu

: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"

umask 077
cat > /tmp/s3.json <<EOF
{
  "identities": [
    {
      "name": "app",
      "credentials": [{ "accessKey": "${S3_ACCESS_KEY}", "secretKey": "${S3_SECRET_KEY}" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
EOF

exec weed server \
  -dir=/data \
  -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB=256 \
  -volume.max=30 \
  -s3 \
  -s3.port=8333 \
  -s3.config=/tmp/s3.json
