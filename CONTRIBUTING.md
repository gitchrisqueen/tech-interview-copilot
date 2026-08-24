# Contributing

## Local development

```bash
npm install && npm test          # JS: node:test against app/profile.js and app/rag.js
```

There is no dedicated Python test suite in this app repo (the tested Python logic lives in
[copilot-core](https://github.com/gitchrisqueen/copilot-core)); CI still lints and syntax-checks
every `.py` file here.

## Branch protection (repo owner setup, one time)

This repo is maintained solo, and GitHub does not allow a PR author to approve their own PR -- a
literal "1 human approval required" rule would deadlock every merge. The review requirement is
instead satisfied by the `claude-review` workflow: it posts a review comment on every PR and its
own job exit code is a **required status check**, so it genuinely blocks a bad merge even with
zero required human approvals.

**Settings -> Rules -> Rulesets -> New branch ruleset**, name `main-protection`, target the
default branch, Enforcement: Active.

- Bypass list: **repo admin only** (an audited emergency hatch).
- Restrict deletions: on
- Block force pushes: on
- Require linear history: on
- Require a pull request before merging: on
  - Required approvals: **0**
  - Dismiss stale approvals on new commits: on
  - Require review from Code Owners: **off** (would deadlock a solo maintainer)
  - Require conversation resolution before merging: on
- Require status checks to pass: on, require branches to be up to date, required checks:
  `js`, `python`, `shell`, `scrub`, `review` (the claude-review job), `codecov/project`,
  `codecov/patch` (the codecov pair only becomes selectable after the first coverage upload).

**Settings -> General**: allow squash merge only; auto-delete head branches; Issues enabled.

**Settings -> Advanced Security**: Dependabot alerts + security updates on; CodeQL default setup
on; secret scanning + push protection on.

## Required repo secrets

- `ANTHROPIC_API_KEY` -- for the claude-review workflow
- `CODECOV_TOKEN` -- from the CodeCov GitHub App install

## Coverage policy

`codecov.yml`'s `project` target tracks the real measured baseline (not 80%) and can only ratchet
up (`threshold: 0`); the `patch` target holds all NEW code to 80% from day one. See README.md's
"Development, testing, and contributing" section. Raise the project target in `codecov.yml` as
dedicated test PRs land -- never lower it, and never add a coverage exclude to make a number
rather than to document a genuinely untestable block (browser-only code, an `if __name__ ==
"__main__"` guard).

## Privacy

This repo is public. The `scrub` CI job greps for a short list of known-private terms as a
backstop, but the real control is discipline: **never** commit anything under `profiles/local/`,
`.env`, `logs/`, `voice-profiles/`, or `docs/uploads/` -- they are git-ignored for exactly this
reason. See [profiles/README.md](profiles/README.md).
