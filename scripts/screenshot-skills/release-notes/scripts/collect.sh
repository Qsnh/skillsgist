#!/usr/bin/env bash
git log --merges --pretty="%s" "$(git describe --tags --abbrev=0)"..HEAD
