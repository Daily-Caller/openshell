#!/usr/bin/env bash
if [ $# -ne 2 ]; then echo "Usage: create-sandbox.sh <name> <path>"; exit 1; fi
openshell sandbox create --name "$1" --from . --policy policy.yaml --driver-config-json "$(jq --arg src "$2" --arg tgt "/sandbox/$1" '.docker.mounts += [{"type":"bind","source":$src,"target":$tgt,"read_only":false}]' driver-config.json)"
