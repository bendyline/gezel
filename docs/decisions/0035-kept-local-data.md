# 0035 — A connection's data can stay on models on this computer

Status: Accepted (2026-11). Contract:
[kept-local-data.md](../kept-local-data.md).

## Context

Gezel has its own Google sign-in app. Google's Workspace policy allows a
transfer of that data only for a feature the person is using and with their
consent, and forbids using it to train general models. Gezel runs on models
here and on cloud providers the person chooses, and some providers' personal
plans train on conversations. Until now the privacy policy could only ask
people to choose a plan that does not.

Cameras already had a narrower answer: `allowCloudModels` per camera, checked
where pixels are read. Text leaks in more ways than pixels. A search result, a
file name, a memory, a summary, a colleague's reply and a transcript replayed
to a new provider all carry an event's title.

## Decision

1. **Consent is per connection, off until given, and only the person's.** The
   form and the row say what each answer sends.
2. **Withhold the data, not the gezel.** A cloud gezel keeps working in the
   project and is told why it cannot read the connection. Refusing cloud models
   in the whole project would have broken the Default project for anyone whose
   Meester runs on a cloud model.
3. **Judge every read by the caller's model**, at the daemon, on the real file.
4. **Mark what was shown.** A local conversation that read the data stays
   local, and so does what follows from it: its task, its replies, its
   memories and the artifacts it writes.
5. **The list of types is code.** A catalog entry cannot decide that consent is
   unnecessary.

## Consequences

- A person who uses only local models notices nothing. One who uses cloud
  models is asked once, while connecting.
- A mixed crew cannot pass a kept conversation to a cloud gezel. The refusal
  names the two ways forward.
- Workspace files and the shared library are not tracked. They are the
  person's own, and CLI agents read them directly.
- Existing Google connections start kept. Their cloud gezels lose access until
  the person allows it.
