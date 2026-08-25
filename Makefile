.PHONY: verify check ci

SHELL := /usr/bin/env bash

verify:
	npm run verify

check:
	npm run check

ci:
	npm run check
