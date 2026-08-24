# Interview profiles

An interview profile tells the copilot which company and role an interview is for, before the
first question is asked. `app/profile.js` loads the active one and renders it into a labeled block
that every LLM prompt includes automatically.

## The shipped demo profile

`profiles/example/profile.json` is a fictional company ("Acme Robotics") with placeholder text in
every field. `profiles/index.json` lists it, and `app/config.js` sets it as the default
`activeId`. It exists so the app is useful out of the box and so `test/profile.test.js` has a
public fixture to assert against.

## Adding your own (real) profile

**Never commit a real profile to this repo** -- company research, an interview strategy, and a
do-not-say list are exactly the kind of content that should stay on your machine. The intended
place for it is:

```
profiles/local/<your-id>/profile.json
```

`profiles/local/` is entirely git-ignored (see `.gitignore`), so anything under it never enters
git history, no matter how you build or edit it.

1. Copy `profiles/example/profile.json` to `profiles/local/<your-id>/profile.json` and fill it in.
   Set the `"id"` field inside it to `"local/<your-id>"` (with the `local/` prefix -- this is what
   makes `profile.js`'s path resolution find the file without any entry in the tracked
   `profiles/index.json`).
2. Point the app at it, either:
   - Edit `app/config.js`'s `profile.activeId` to `"local/<your-id>"`, or
   - (Preferred -- doesn't touch a tracked file) create/edit the git-ignored
     `app/settings.json`:
     ```json
     { "profile": { "activeId": "local/your-id" } }
     ```
3. Relaunch. The Prep tab's profile editor works the same way for a local profile as for the
   example one; edits there are saved as per-machine overrides and never touch the profile file
   itself.

## Schema

See `profiles/example/profile.json` for the full shape: `company` (name, domain, one_liner,
thesis, facts[], tech_context[]), `role` (title, what_they_want[]), `interview` (date, format,
duration, interviewer info, stage, notes), `must_hit[]`, `do_not_say[]`, `objections[]`
(objection/answer/artifact), `questions_to_ask[]`.
