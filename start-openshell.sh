#!/usr/bin/env bash
if [ $# -ne 2 ]; then echo "Usage: start-openshell.sh <name> <path>"; exit 1; fi
openshell sandbox create --name openshell --from . --policy policy.yaml --driver-config-json "$(cat driver-config.json)"
