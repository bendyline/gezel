# gezel-sandbox

A first-party Linux helper that starts a command under rules it cannot
lift: it sets `no_new_privs`, applies each rule it was asked for, and execs
the command.

```sh
gezel-sandbox --deny-net -- node script.js
gezel-sandbox --features
gezel-sandbox --self-test
gezel-sandbox --help
```

## The flag contract

- Each rule is a flag, and a run must name at least one.
- An unknown flag exits 64 instead of running the command, so a newer
  runner asking an older helper for a rule it lacks fails loudly.
- `--features` prints the rules this build has, one per line. Whether the
  kernel enforces them is the caller's to prove.
- Exit codes: 64 usage, 126 a rule could not be applied, 127 the command
  could not be started.

A new rule must be one an unprivileged process can apply to itself before
it execs (seccomp, Landlock, resource limits). That is what works under
Docker's default seccomp profile; creating namespaces does not.

## Rules

`--deny-net` is the sandbox runner's (`packages/service/src/sandbox/runner.ts`)
network boundary for `denyNet` scripts when `systemd-run --user` is not
available: inside a Gezel container, on WSL, or on a server with no user
session. It gives the same guarantee as systemd's
`RestrictAddressFamilies=AF_UNIX`:

- `socket()` and `socketpair()` create `AF_UNIX` sockets only; every other
  family gets `EAFNOSUPPORT`.
- A syscall made under a foreign ABI (i386 or x32 on x86-64) kills the
  process, so `socketcall()` cannot route around the check.
- `io_uring_*`, `ptrace`, `process_vm_*` and `pidfd_getfd` are refused,
  because each could reach the network or another process outside the
  filter. `pidfd_getfd` would copy an open socket out of the parent, which is
  the Gezel daemon (native-v0.1.57 lacked this rule).

The runner reads `--features` and then proves the rule with a real
`AF_INET` connect before trusting the helper.

The helper does not confine the file system yet; the runner's Node
permission model does that, as it does under systemd. Landlock is the
planned next rule. It also closes `/proc/<pid>/mem`, which seccomp cannot
filter by path: where Yama's `ptrace_scope` is 0, a script that escaped the
permission model could open the daemon's memory, and Landlock refuses
ptrace-mode access outside its domain. It links the system C library like the other engines,
and nothing it uses needs more than the release's glibc 2.38 floor. See
ADR 0029.

## Build

`native/helpers/sandbox/build.sh` (CMake + Ninja) runs the self-test and
the flag-contract tests, then writes `native/build/<platform>/gezel-sandbox`.
CI builds it in `build-native.yml` for `linux-x64` and `linux-arm64`.
