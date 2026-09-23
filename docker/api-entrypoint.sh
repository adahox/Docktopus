#!/bin/sh
set -e
export HOME=/tmp
export DOCKER_CONFIG=/tmp/docker
mkdir -p /tmp/docker
exec node dist/server.js
